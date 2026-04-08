import path from "node:path";

import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";

import {
	FOOTER_LINES,
	HEADER_LINES,
	MAX_LEFT_WIDTH,
	MIN_DIFF_WIDTH,
	MIN_LEFT_WIDTH,
	PAGE_SCROLL_RATIO,
	PANE_HEADER_LINES,
} from "../constants";
import { countCodeAnnotationsForLine, describeAnnotationTarget } from "../lib/annotations";
import {
	type AnnotationModalState,
	computeAnnotationModalWidth,
	createAnnotationModal,
	overlayAnnotationModal,
} from "./annotation-modal";
import { loadCodePreview } from "../lib/code-preview";
import { flattenCodeTree, scanCodeTree } from "../lib/code-tree";
import { getVisibleHostHeight } from "../lib/host-layout";
import { fitLine, replaceTabs, wrapAnsiLines } from "../lib/render";
import {
	renderShortcutFooterLine,
	renderShortcutHelp,
	renderShortcutHint,
	type ShortcutHintAction,
	type ShortcutKeySpec,
} from "../lib/shortcut-ui";
import type {
	CodeAnnotationTarget,
	CodeDirNode,
	CodeLoadedPreview,
	CodeVisibleRow,
	CodeViewerState,
	ViewerAnnotationController,
	ViewerPane,
	ViewerResult,
} from "../types";

interface RenderLineModel {
	text: string;
	selected: boolean;
}

interface WrappedRenderModel {
	rows: RenderLineModel[];
	selectedStart?: number;
	selectedEnd?: number;
}

interface CodeShortcutAction extends ShortcutHintAction {
	match(data: string): boolean;
	run(data: string): void;
}

function createEmptyRoot(rootPath: string): CodeDirNode {
	return {
		kind: "dir",
		name: path.basename(rootPath),
		path: "",
		parentPath: null,
		descendantFileCount: 0,
		children: [],
	};
}

export class CodeViewerComponent implements Component, Focusable {
	private readonly rootName: string;
	private readonly annotationController: ViewerAnnotationController;
	private readonly initialSelectedPath?: string;
	private treeRoot: CodeDirNode;
	private visibleRows: CodeVisibleRow[] = [];
	private collapsedDirs: Set<string>;
	private selectedPath: string | null = null;
	private selectedIndex = 0;
	private treeScroll = 0;
	private previewScroll = 0;
	private treePaneVisible: boolean;
	private activePane: ViewerPane;
	private selectedLineIndex: number;
	private selectionAnchorLineIndex: number | null;
	private loading = true;
	private refreshing = false;
	private errorMessage?: string;
	private previewCache = new Map<string, CodeLoadedPreview>();
	private cachedPreviewModel?: { key: string; model: WrappedRenderModel };
	private loadingPreviewKey?: string;
	private refreshToken = 0;
	private lastSelectedPreviewKey?: string;
	private lastActionMessage?: string;
	private annotationModal?: AnnotationModalState<CodeAnnotationTarget>;
	private showHelp = false;
	private _focused = false;
	private closed = false;

	constructor(
		private readonly rootPath: string,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: ViewerResult | undefined) => void,
		options: {
			state?: CodeViewerState;
			annotationController: ViewerAnnotationController;
		},
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.rootName = path.basename(rootPath);
		this.treeRoot = createEmptyRoot(rootPath);
		this.annotationController = options.annotationController;
		this.initialSelectedPath = options.state?.selectedPath;
		this.collapsedDirs = new Set(options.state?.collapsedDirs ?? []);
		this.treePaneVisible = options.state?.treePaneVisible ?? true;
		this.activePane = options.state?.activePane ?? "tree";
		this.selectedLineIndex = Math.max(0, options.state?.selectedLineIndex ?? 0);
		this.selectionAnchorLineIndex = options.state?.selectionAnchorLineIndex ?? null;
		void this.initialize();
	}

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: ViewerResult | undefined) => void;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.annotationModal) this.annotationModal.editor.focused = value;
	}

	invalidate(): void {
		this.cachedPreviewModel = undefined;
		this.annotationModal?.editor.invalidate();
	}

	handleInput(data: string): void {
		if (this.closed) return;

		if (this.showHelp) {
			if (matchesKey(data, "?") || this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q")) {
				this.toggleHelp(false);
			}
			return;
		}

		if (this.annotationModal) {
			this.annotationModal.editor.handleInput(data);
			this.tui.requestRender();
			return;
		}

		for (const action of this.shortcutActions()) {
			if (!action.match(data)) continue;
			action.run(data);
			return;
		}
	}

	render(width: number): string[] {
		const height = this.visibleHostHeight(width);
		const lines: string[] = [];
		const showTreePane = this.treePaneVisible && width > MIN_DIFF_WIDTH + 8;
		const leftWidth = showTreePane ? this.computeLeftPaneWidth(width) : 0;
		const rightWidth = showTreePane ? Math.max(0, width - leftWidth - 1) : width;
		const separator = this.theme.fg("border", "│");
		const bodyHeight = Math.max(1, height - HEADER_LINES - FOOTER_LINES);
		const paneContentHeight = Math.max(1, bodyHeight - PANE_HEADER_LINES);

		lines.push(...this.renderHeader(width));

		if (this.showHelp) {
			lines.push(...this.renderHelpBody(width, bodyHeight));
			lines.push(...this.renderHelpFooter(width));
			while (lines.length < height) lines.push(" ".repeat(width));
			return lines.slice(0, height).map((line) => fitLine(line, width));
		}

		const rightTitle = this.renderRightPaneTitle(rightWidth);
		if (showTreePane) {
			const leftTitle =
				this.theme.fg("accent", this.theme.bold(`Files (${this.treeRoot.descendantFileCount})`)) +
				this.theme.fg("muted", ` · ${this.rootName}`) +
				(this.isContentPaneActive() ? this.theme.fg("accent", " · focus content") : "");
			lines.push(fitLine(leftTitle, leftWidth) + separator + fitLine(rightTitle, rightWidth));

			const leftLines = this.renderTreeLines(leftWidth, paneContentHeight);
			let rightLines = this.renderPreviewLines(rightWidth, paneContentHeight);
			if (this.annotationModal) rightLines = this.renderAnnotationModalIntoPane(rightLines, rightWidth);
			for (let i = 0; i < paneContentHeight; i++) {
				lines.push((leftLines[i] ?? " ".repeat(leftWidth)) + separator + (rightLines[i] ?? " ".repeat(rightWidth)));
			}
		} else {
			lines.push(fitLine(rightTitle, rightWidth));
			let rightLines = this.renderPreviewLines(rightWidth, paneContentHeight);
			if (this.annotationModal) rightLines = this.renderAnnotationModalIntoPane(rightLines, rightWidth);
			lines.push(...rightLines);
		}

		lines.push(...this.renderFooter(width));
		while (lines.length < height) lines.push(" ".repeat(width));
		return lines.slice(0, height).map((line) => fitLine(line, width));
	}

	private isTreePaneRendered(): boolean {
		return this.treePaneVisible && this.tui.terminal.columns > MIN_DIFF_WIDTH + 8;
	}

	private isContentPaneActive(): boolean {
		return !this.isTreePaneRendered() || this.activePane === "content";
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done(undefined);
	}

	private switchView(view: "diff"): void {
		if (this.closed) return;
		this.closed = true;
		this.done({ action: "switch", view, state: this.snapshotState() });
	}

	private snapshotState(): CodeViewerState {
		return {
			view: "code",
			selectedPath: this.selectedPath ?? undefined,
			collapsedDirs: [...this.collapsedDirs],
			treePaneVisible: this.treePaneVisible,
			activePane: this.isTreePaneRendered() ? this.activePane : "content",
			selectedLineIndex: this.selectedLineIndex,
			selectionAnchorLineIndex: this.selectionAnchorLineIndex ?? undefined,
		};
	}

	private async initialize(): Promise<void> {
		try {
			await this.reloadTree(false);
		} catch (error) {
			this.loading = false;
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private async reloadTree(preserveSelection: boolean): Promise<void> {
		const refreshToken = ++this.refreshToken;
		const preferredPath = preserveSelection ? this.selectedPath ?? this.initialSelectedPath : this.initialSelectedPath;
		if (this.loading) this.errorMessage = undefined;
		else this.refreshing = true;
		this.tui.requestRender();

		try {
			const treeRoot = await scanCodeTree(this.rootPath);
			if (this.closed || refreshToken !== this.refreshToken) return;

			this.treeRoot = treeRoot;
			this.previewCache.clear();
			this.cachedPreviewModel = undefined;
			this.loadingPreviewKey = undefined;
			this.rebuildVisibleRows(preferredPath);
			this.loading = false;
			this.refreshing = false;
			this.errorMessage = undefined;
			this.tui.requestRender();
		} catch (error) {
			if (this.closed || refreshToken !== this.refreshToken) return;
			this.loading = false;
			this.refreshing = false;
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private rebuildVisibleRows(preferredPath?: string): void {
		const previousPath = preferredPath ?? this.selectedPath ?? undefined;
		const oldSelectedPath = this.selectedPath;
		this.visibleRows = flattenCodeTree(this.treeRoot, this.collapsedDirs);

		let nextIndex = this.firstSelectableIndex();
		if (previousPath) {
			const match = this.findVisibleIndex(previousPath);
			if (match >= 0) nextIndex = match;
		}

		this.selectedIndex = this.visibleRows.length === 0 ? 0 : Math.max(0, Math.min(nextIndex, this.visibleRows.length - 1));
		this.selectedPath = this.visibleRows[this.selectedIndex]?.node.path ?? null;
		if (this.selectedPath !== oldSelectedPath) {
			this.previewScroll = 0;
			this.lastSelectedPreviewKey = undefined;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
		}
		if (this.getSelectedRow()?.node.kind !== "file" && this.activePane === "content") this.activePane = "tree";
		this.ensureTreeSelectionVisible(this.previewViewportHeight());
	}

	private computeLeftPaneWidth(width: number): number {
		const maxLeft = Math.max(0, width - 1 - MIN_DIFF_WIDTH);
		if (maxLeft < MIN_LEFT_WIDTH) return Math.max(0, Math.min(width - 1, Math.floor(width * 0.38)));
		const preferred = Math.floor(width * 0.34);
		return Math.max(MIN_LEFT_WIDTH, Math.min(Math.min(MAX_LEFT_WIDTH, maxLeft), preferred));
	}

	private currentRightPaneWidth(): number {
		const width = Math.max(1, this.tui.terminal.columns);
		if (!this.isTreePaneRendered()) return width;
		const leftWidth = this.computeLeftPaneWidth(width);
		return Math.max(0, width - leftWidth - 1);
	}

	private renderHeader(width: number): string[] {
		const title =
			this.theme.fg("accent", this.theme.bold("shoulderpeek")) +
			this.theme.fg("muted", " · code · ") +
			this.theme.fg("text", this.rootName) +
			(this.showHelp ? this.theme.fg("accent", " · help") : "");

		let subtitle: string;
		if (this.errorMessage) {
			subtitle = this.theme.fg("error", this.errorMessage);
		} else {
			const annotationCount = this.annotationController.list().length;
			subtitle =
				this.theme.fg("muted", this.rootPath) +
				this.theme.fg("muted", ` · files ${this.treeRoot.descendantFileCount}`);
			if (annotationCount > 0) {
				const notesAction: ShortcutHintAction = {
					id: "header-notes",
					keys: [{ kind: "raw", value: "n" }],
					footerLabel: "open notes",
					section: "Annotate",
					footerRow: 1,
				};
				const reviewAction: ShortcutHintAction = {
					id: "header-review",
					keys: [{ kind: "raw", value: "d" }],
					footerLabel: annotationCount === 1 ? "review note" : `review ${annotationCount} notes`,
					section: "Annotate",
					footerRow: 1,
				};
				subtitle +=
					this.theme.fg("warning", ` · ${annotationCount} pending ${annotationCount === 1 ? "note" : "notes"}`) +
					this.theme.fg("muted", " · ") +
					renderShortcutHint(this.theme, this.keybindings, notesAction) +
					this.theme.fg("muted", " · ") +
					renderShortcutHint(this.theme, this.keybindings, reviewAction);
			}
			if (this.loading) subtitle += this.theme.fg("warning", " · loading…");
			else if (this.refreshing) subtitle += this.theme.fg("warning", " · refreshing…");
			else if (this.lastActionMessage) subtitle += this.theme.fg("accent", ` · ${this.lastActionMessage}`);
		}

		return [fitLine(title, width), fitLine(subtitle, width)];
	}

	private renderFooter(width: number): string[] {
		if (this.annotationModal) return this.renderModalFooter(width);
		const actions = this.shortcutActions();
		return [
			renderShortcutFooterLine(
				this.theme,
				this.keybindings,
				width,
				actions.filter((action) => action.footerRow === 1),
			),
			renderShortcutFooterLine(
				this.theme,
				this.keybindings,
				width,
				actions.filter((action) => action.footerRow === 2),
			),
		];
	}

	private renderModalFooter(width: number): string[] {
		return [
			fitLine(this.theme.fg("dim", "Annotation editor active — use the inline editor hints above."), width),
			fitLine(this.theme.fg("dim", "Shoulderpeek shortcuts pause until the editor closes."), width),
		];
	}

	private renderHelpFooter(width: number): string[] {
		const closeHelpAction: ShortcutHintAction = {
			id: "close-help",
			keys: [
				{ kind: "raw", value: "?" },
				{ kind: "binding", value: "tui.select.cancel", fallback: "esc" },
				{ kind: "raw", value: "q" },
			],
			footerLabel: "close help",
			section: "General",
			footerRow: 1,
		};
		return [
			renderShortcutFooterLine(this.theme, this.keybindings, width, [closeHelpAction]),
			fitLine(this.theme.fg("dim", "Close help first, then use Esc/Q to close shoulderpeek."), width),
		];
	}

	private renderHelpBody(width: number, height: number): string[] {
		const subtitle = this.isContentPaneActive()
			? "Content shortcuts shown for the selected file preview."
			: "Tree shortcuts shown for the file explorer.";
		return renderShortcutHelp(this.theme, this.keybindings, width, height, "Code view shortcuts", subtitle, this.shortcutActions());
	}

	private shortcutActions(): CodeShortcutAction[] {
		const row = this.getSelectedRow();
		const isContent = this.isContentPaneActive();
		const canSwitchPane = this.canSwitchPane();
		const annotatable = this.hasAnnotatableSelection();
		const rangeActive = this.selectionAnchorLineIndex != null;
		const annotationCount = this.annotationController.list().length;
		const actions: CodeShortcutAction[] = [];

		const closeKeys: ShortcutKeySpec[] = [
			{ kind: "binding", value: "tui.select.cancel", fallback: "esc" },
			{ kind: "raw", value: "q" },
		];

		if (isContent) {
			actions.push({
				id: "move-lines",
				keys: [
					{ kind: "binding", value: "tui.select.up", fallback: "up" },
					{ kind: "binding", value: "tui.select.down", fallback: "down" },
				],
				footerLabel: "line",
				helpLabel: "move the selected line",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.up")) this.moveContentLine(-1);
					else this.moveContentLine(1);
				},
			});
			if (annotatable) {
				actions.push(
					{
						id: "range",
						keys: [{ kind: "raw", value: "space" }],
						footerLabel: rangeActive ? "clear range" : "start range",
						helpLabel: rangeActive
							? "clear the active line range and return to single-line selection"
							: "start selecting a line range from the current line",
						section: "Annotate",
						footerRow: 1,
						match: (data) => matchesKey(data, "space"),
						run: () => this.toggleRangeAnchor(),
					},
					{
						id: "annotate",
						keys: [{ kind: "raw", value: "a" }],
						footerLabel: "annotate",
						helpLabel: "edit the annotation for the current line or range",
						section: "Annotate",
						footerRow: 1,
						match: (data) => matchesKey(data, "a"),
						run: () => this.requestAnnotation(),
					},
				);
			}
			if (this.isTreePaneRendered()) {
				actions.push({
					id: "back-to-tree",
					keys: [{ kind: "raw", value: "left" }],
					footerLabel: "tree",
					helpLabel: "return focus to the tree pane",
					section: "Navigate",
					footerRow: 1,
					match: (data) => matchesKey(data, "left"),
					run: () => this.focusTreePane(),
				});
			}
		} else {
			actions.push({
				id: "move-tree",
				keys: [
					{ kind: "binding", value: "tui.select.up", fallback: "up" },
					{ kind: "binding", value: "tui.select.down", fallback: "down" },
				],
				footerLabel: "move",
				helpLabel: "move the file selection",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.up")) this.moveSelection(-1);
					else this.moveSelection(1);
				},
			});
			if (this.isTreePaneRendered() && row) {
				actions.push(
					{
						id: "open",
						keys: [
							{ kind: "binding", value: "tui.select.confirm", fallback: "enter" },
							{ kind: "raw", value: "right" },
						],
						footerLabel: row.node.kind === "file" ? "open" : "expand",
						helpLabel: row.node.kind === "file" ? "open the file and focus content" : "expand the selected directory",
						section: "Navigate",
						footerRow: 1,
						match: (data) => this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "right"),
						run: () => {
							if (row.node.kind === "file") this.focusContentPane();
							else this.expandOrToggleDirectory(true);
						},
					},
					{
						id: "collapse",
						keys: [{ kind: "raw", value: "left" }],
						footerLabel: "collapse",
						helpLabel: row.node.kind === "file" ? "select the parent directory" : "collapse the selected directory",
						section: "Navigate",
						footerRow: 1,
						match: (data) => matchesKey(data, "left"),
						run: () => this.expandOrToggleDirectory(false),
					},
				);
			}
		}

		actions.push(
			{
				id: "page",
				keys: [
					{ kind: "binding", value: "tui.select.pageUp", fallback: "pageUp" },
					{ kind: "binding", value: "tui.select.pageDown", fallback: "pageDown" },
				],
				footerLabel: isContent ? "page" : "preview",
				helpLabel: isContent ? "scroll by page and keep the selected line visible" : "scroll the preview pane by page",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.pageUp")) {
						if (isContent) this.moveContentLine(-this.previewPageStep());
						else this.scrollPreviewBy(-this.previewPageStep());
					} else if (isContent) this.moveContentLine(this.previewPageStep());
					else this.scrollPreviewBy(this.previewPageStep());
				},
			},
			{
				id: "bounds",
				keys: [{ kind: "raw", value: "home" }, { kind: "raw", value: "end" }],
				footerLabel: "top/btm",
				helpLabel: "jump to the top or bottom",
				section: "Navigate",
				footerRow: 1,
				match: (data) => matchesKey(data, "home") || matchesKey(data, "end"),
				run: (data) => {
					if (matchesKey(data, "home")) {
						if (isContent) this.moveContentToBoundary("start");
						else {
							this.previewScroll = 0;
							this.tui.requestRender();
						}
					} else if (isContent) this.moveContentToBoundary("end");
					else {
						this.previewScroll = Number.MAX_SAFE_INTEGER;
						this.tui.requestRender();
					}
				},
			},
		);

		if (canSwitchPane) {
			actions.push({
				id: "pane",
				keys: [{ kind: "raw", value: "tab" }],
				footerLabel: "pane",
				helpLabel: "switch between the tree and content panes",
				section: "Navigate",
				footerRow: 2,
				match: (data) => matchesKey(data, "tab"),
				run: () => this.toggleActivePane(),
			});
		}

		if (annotationCount > 0) {
			actions.push(
				{
					id: "notes",
					keys: [{ kind: "raw", value: "n" }],
					footerLabel: annotationCount === 1 ? "note list" : `notes ${annotationCount}`,
					helpLabel:
						annotationCount === 1
							? "open the pending note list"
							: `open the pending note list (${annotationCount} notes)`,
					section: "Annotate",
					footerRow: 2,
					sticky: true,
					match: (data) => matchesKey(data, "n"),
					run: () => {
						this.done({ action: "notes", state: this.snapshotState() });
						this.closed = true;
					},
				},
				{
					id: "draft",
					keys: [{ kind: "raw", value: "d" }],
					footerLabel: annotationCount === 1 ? "review note" : `review ${annotationCount} notes`,
					helpLabel:
						annotationCount === 1
							? "load the pending annotation into Pi's input editor for review"
							: `load ${annotationCount} pending annotations into Pi's input editor for review`,
					section: "Annotate",
					footerRow: 2,
					sticky: true,
					match: (data) => matchesKey(data, "d"),
					run: () => {
						this.done({ action: "draft", state: this.snapshotState() });
						this.closed = true;
					},
				},
			);
		}

		actions.push(
			{
				id: "switch-view",
				keys: [{ kind: "raw", value: "v" }],
				footerLabel: "diff view",
				helpLabel: "switch to the diff view",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "v"),
				run: () => this.switchView("diff"),
			},
			{
				id: "toggle-tree",
				keys: [{ kind: "raw", value: "t" }],
				footerLabel: "tree",
				helpLabel: "toggle the tree pane",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "t"),
				run: () => this.toggleTreePane(),
			},
			{
				id: "refresh",
				keys: [{ kind: "raw", value: "r" }],
				footerLabel: "refresh",
				helpLabel: "rescan the file tree",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "r"),
				run: () => {
					void this.reloadTree(true);
				},
			},
			{
				id: "help",
				keys: [{ kind: "raw", value: "?" }],
				footerLabel: "help",
				helpLabel: "show shortcut help",
				section: "General",
				footerRow: 2,
				sticky: true,
				match: (data) => matchesKey(data, "?"),
				run: () => this.toggleHelp(),
			},
			{
				id: "close",
				keys: closeKeys,
				footerLabel: "close",
				helpLabel: "close shoulderpeek",
				section: "General",
				footerRow: 2,
				sticky: true,
				match: (data) => this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q"),
				run: () => this.close(),
			},
		);

		return actions;
	}

	private hasAnnotatableSelection(): boolean {
		const row = this.getSelectedRow();
		const cached = this.getLoadedPreviewForSelection();
		return Boolean(row && row.node.kind === "file" && cached && cached.type === "text" && cached.plainLines.length > 0);
	}

	private canSwitchPane(): boolean {
		if (!this.isTreePaneRendered()) return false;
		if (this.isContentPaneActive()) return true;
		return this.getSelectedRow()?.node.kind === "file";
	}

	private toggleActivePane(): void {
		if (!this.canSwitchPane()) return;
		if (this.isContentPaneActive()) this.focusTreePane();
		else this.focusContentPane();
	}

	private toggleHelp(next?: boolean): void {
		this.showHelp = next ?? !this.showHelp;
		this.tui.requestRender();
	}

	private renderRightPaneTitle(width: number): string {
		const row = this.getSelectedRow();
		if (!row) return this.theme.fg("muted", "Code preview");
		if (row.node.kind === "dir") {
			const label = row.node.path || this.rootName;
			return this.theme.fg("accent", this.theme.bold(label)) + this.theme.fg("muted", " · directory");
		}

		const range = this.currentRangeLabel();
		const suffix = this.isContentPaneActive() && range ? this.theme.fg("accent", ` · ${range}`) : "";
		return truncateToWidth(this.theme.fg("accent", this.theme.bold(row.node.path)) + suffix, width);
	}

	private renderTreeLines(width: number, height: number): string[] {
		if (width <= 0) return new Array(height).fill("");
		if (this.loading && this.visibleRows.length === 0) {
			return this.fillVertical([this.theme.fg("muted", "Scanning files…")], width, height);
		}
		if (this.visibleRows.length === 0) {
			return this.fillVertical([this.theme.fg("muted", "No files to preview")], width, height);
		}

		this.ensureTreeSelectionVisible(height);
		const end = Math.min(this.visibleRows.length, this.treeScroll + height);
		const slice = this.visibleRows.slice(this.treeScroll, end);
		const lines = slice.map((row, index) => this.renderTreeRow(row, width, this.treeScroll + index === this.selectedIndex));
		return this.fillVertical(lines, width, height, true);
	}

	private renderTreeRow(row: CodeVisibleRow, width: number, selected: boolean): string {
		const indent = "  ".repeat(row.depth);
		const icon =
			row.node.kind === "dir"
				? this.collapsedDirs.has(row.node.path)
					? this.theme.fg("muted", "▸")
					: this.theme.fg("muted", "▾")
				: this.theme.fg("muted", "•");
		const suffix = row.node.kind === "dir" ? this.theme.fg("muted", ` (${row.node.descendantFileCount})`) : "";
		const line = `${indent}${icon} ${this.theme.fg("text", row.node.name)}${suffix}`;
		const fitted = fitLine(line, width);
		return selected ? this.theme.bg("selectedBg", fitted) : fitted;
	}

	private renderPreviewLines(width: number, height: number): string[] {
		if (width <= 0) return new Array(height).fill("");
		if (this.loading) {
			return this.fillVertical([this.theme.fg("muted", "Loading code view…")], width, height);
		}
		if (this.errorMessage && this.treeRoot.descendantFileCount === 0) {
			return this.fillVertical([this.theme.fg("error", this.errorMessage)], width, height);
		}

		const row = this.getSelectedRow();
		if (!row) {
			return this.fillVertical([this.theme.fg("muted", "No files to preview.")], width, height);
		}
		if (row.node.kind === "dir") {
			return this.renderDirectorySummary(row.node, width, height);
		}

		const key = `${this.refreshToken}|${row.node.path}`;
		if (this.lastSelectedPreviewKey !== key) {
			this.lastSelectedPreviewKey = key;
			this.previewScroll = 0;
			this.selectionAnchorLineIndex = null;
		}
		this.maybeStartPreviewLoad(row.node.path, key);

		const cached = this.previewCache.get(key);
		if (!cached) {
			return this.fillVertical([this.theme.fg("muted", "Loading file preview…")], width, height);
		}

		if (cached.type !== "text") {
			const rawLines: string[] = [];
			for (const line of cached.metadataLines) rawLines.push(this.theme.fg("muted", line));
			if (cached.metadataLines.length > 0) rawLines.push("");
			for (let i = 0; i < cached.lines.length; i++) {
				rawLines.push(i === 0 ? this.theme.fg("warning", cached.lines[i]!) : this.theme.fg("muted", cached.lines[i]!));
			}
			const wrapped = wrapAnsiLines(rawLines, width);
			const maxScroll = Math.max(0, wrapped.length - height);
			if (this.previewScroll > maxScroll) this.previewScroll = maxScroll;
			const visible = wrapped.slice(this.previewScroll, this.previewScroll + height).map((line) => fitLine(line, width));
			return this.fillVertical(visible, width, height, true);
		}

		this.clampSelectedLine(cached.plainLines.length);
		const model = this.getPreviewModel(cached, width, row.node.path, key);
		if (this.isContentPaneActive()) this.ensureSelectedPreviewLineVisible(model, height);
		const maxScroll = Math.max(0, model.rows.length - height);
		if (this.previewScroll > maxScroll) this.previewScroll = maxScroll;
		if (this.previewScroll < 0) this.previewScroll = 0;
		const visible = model.rows
			.slice(this.previewScroll, this.previewScroll + height)
			.map((rowModel) => (rowModel.selected ? this.theme.bg("selectedBg", fitLine(rowModel.text, width)) : fitLine(rowModel.text, width)));
		return this.fillVertical(visible, width, height, true);
	}

	private renderAnnotationModalIntoPane(baseLines: string[], paneWidth: number): string[] {
		if (!this.annotationModal) return baseLines;
		const modalWidth = computeAnnotationModalWidth(paneWidth);
		return overlayAnnotationModal(baseLines, paneWidth, this.annotationModal.editor.render(modalWidth));
	}

	private buildPreviewModel(cached: CodeLoadedPreview, width: number, filePath: string): WrappedRenderModel {
		const logicalLines: RenderLineModel[] = [];
		for (const line of cached.metadataLines) logicalLines.push({ text: this.theme.fg("muted", line), selected: false });
		if (cached.metadataLines.length > 0) logicalLines.push({ text: "", selected: false });

		const range = this.getSelectedLineRange(cached.plainLines.length);
		const lineNumberWidth = String(cached.plainLines.length).length;
		const annotations = this.annotationController.list();
		for (let index = 0; index < cached.lines.length; index++) {
			const lineNumber = index + 1;
			const annotationCount = countCodeAnnotationsForLine(annotations, this.rootPath, filePath, lineNumber);
			const selected = this.isContentPaneActive() && index === this.selectedLineIndex;
			const inRange = this.isContentPaneActive() && index >= range.start && index <= range.end;
			const markerChar = selected ? "›" : inRange ? "│" : annotationCount > 0 ? String(Math.min(annotationCount, 9)) : " ";
			const markerColor = selected || inRange || annotationCount > 0 ? "accent" : "dim";
			const marker = this.theme.fg(markerColor, `${markerChar} `);
			const prefix = this.theme.fg("dim", `${String(lineNumber).padStart(lineNumberWidth)} │ `);
			logicalLines.push({
				text: `${marker}${prefix}${replaceTabs(cached.lines[index] ?? "")}`,
				selected,
			});
		}

		const rows: RenderLineModel[] = [];
		let selectedStart: number | undefined;
		let selectedEnd: number | undefined;
		for (const logicalLine of logicalLines) {
			const start = rows.length;
			const wrapped = wrapAnsiLines([logicalLine.text], width);
			const segments = wrapped.length > 0 ? wrapped : [""];
			for (const segment of segments) rows.push({ text: segment, selected: logicalLine.selected });
			if (logicalLine.selected) {
				selectedStart = start;
				selectedEnd = rows.length - 1;
			}
		}

		return { rows, selectedStart, selectedEnd };
	}

	private getPreviewModel(cached: CodeLoadedPreview, width: number, filePath: string, previewKey: string): WrappedRenderModel {
		const modelKey = [
			previewKey,
			String(width),
			this.isContentPaneActive() ? "content" : "tree",
			String(this.selectedLineIndex),
			String(this.selectionAnchorLineIndex ?? ""),
			this.previewAnnotationSignature(filePath),
		].join("|");
		if (this.cachedPreviewModel?.key === modelKey) return this.cachedPreviewModel.model;

		const model = this.buildPreviewModel(cached, width, filePath);
		this.cachedPreviewModel = { key: modelKey, model };
		return model;
	}

	private previewAnnotationSignature(filePath: string): string {
		const ids: string[] = [];
		for (const annotation of this.annotationController.list()) {
			const target = annotation.target;
			if (target.view !== "code") continue;
			if (target.rootPath !== this.rootPath || target.path !== filePath) continue;
			ids.push(annotation.id);
		}
		return ids.join(",");
	}

	private renderDirectorySummary(node: CodeDirNode, width: number, height: number): string[] {
		const lines: string[] = [
			this.theme.fg("accent", this.theme.bold(node.path || this.rootName)),
			this.theme.fg("muted", `${node.descendantFileCount} files under this directory`),
			"",
			this.theme.fg("muted", "Select a file and press Enter to open its preview."),
		];

		const childNames = node.children.slice(0, 8).map((child) => `${child.kind === "dir" ? "▸" : "•"} ${child.name}`);
		if (childNames.length > 0) {
			lines.push("");
			lines.push(this.theme.fg("muted", "Children:"));
			lines.push(...childNames);
		}

		return this.fillVertical(lines.map((line) => fitLine(line, width)), width, height, true);
	}

	private fillVertical(lines: string[], width: number, height: number, alreadyFitted = false): string[] {
		const output = lines.slice(0, height).map((line) => (alreadyFitted ? line : fitLine(line, width)));
		while (output.length < height) output.push(" ".repeat(width));
		return output;
	}

	private getSelectedRow(): CodeVisibleRow | undefined {
		return this.visibleRows[this.selectedIndex];
	}

	private previewKeyForSelectedPath(): string | undefined {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return undefined;
		return `${this.refreshToken}|${row.node.path}`;
	}

	private getLoadedPreviewForSelection(): CodeLoadedPreview | undefined {
		const key = this.previewKeyForSelectedPath();
		if (!key) return undefined;
		return this.previewCache.get(key);
	}

	private maybeStartPreviewLoad(relativePath: string, key: string): void {
		if (this.previewCache.has(key) || this.loadingPreviewKey === key) return;
		this.loadingPreviewKey = key;
		void this.loadPreviewForKey(relativePath, key);
	}

	private async loadPreviewForKey(relativePath: string, key: string): Promise<void> {
		const refreshToken = this.refreshToken;
		try {
			const preview = await loadCodePreview(this.rootPath, relativePath);
			if (this.closed || refreshToken !== this.refreshToken) return;
			this.previewCache.set(key, preview);
			if (this.selectedPath === relativePath && preview.type === "text") {
				this.clampSelectedLine(preview.plainLines.length);
			}
		} finally {
			if (this.loadingPreviewKey === key) this.loadingPreviewKey = undefined;
			if (!this.closed && refreshToken === this.refreshToken) this.tui.requestRender();
		}
	}

	private toggleTreePane(): void {
		this.treePaneVisible = !this.treePaneVisible;
		if (!this.treePaneVisible) this.activePane = "content";
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.visibleRows.length === 0) return;
		const previous = this.selectedPath;
		this.selectedIndex = Math.max(0, Math.min(this.visibleRows.length - 1, this.selectedIndex + delta));
		this.selectedPath = this.visibleRows[this.selectedIndex]?.node.path ?? null;
		if (this.selectedPath !== previous) {
			this.previewScroll = 0;
			this.lastSelectedPreviewKey = undefined;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
		}
		this.ensureTreeSelectionVisible(this.previewViewportHeight());
		this.tui.requestRender();
	}

	private focusContentPane(): void {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return;
		this.activePane = "content";
		this.lastActionMessage = "content focus";
		this.tui.requestRender();
	}

	private focusTreePane(): void {
		this.activePane = "tree";
		this.lastActionMessage = undefined;
		this.tui.requestRender();
	}

	private requestAnnotation(): void {
		if (!this.isContentPaneActive()) {
			this.focusContentPane();
			return;
		}

		const target = this.createAnnotationTarget();
		if (!target) return;
		const existing = this.annotationController.find(target);
		this.openAnnotationModal(target, existing?.note);
	}

	private openAnnotationModal(target: CodeAnnotationTarget, prefill?: string): void {
		this.annotationModal = createAnnotationModal(
			this.tui,
			this.keybindings,
			`Annotation · ${describeAnnotationTarget(target)}`,
			prefill,
			target,
			(value) => this.saveAnnotationModal(value),
			() => this.cancelAnnotationModal(),
		);
		this.annotationModal.editor.focused = this.focused;
		this.lastActionMessage = undefined;
		this.tui.requestRender();
	}

	private saveAnnotationModal(value: string): void {
		const modal = this.annotationModal;
		if (!modal) return;
		const trimmed = value.trim();
		const existing = this.annotationController.find(modal.target);
		if (!trimmed) {
			if (existing) {
				this.annotationController.remove(modal.target);
				this.lastActionMessage = "annotation removed";
			} else {
				this.lastActionMessage = "empty annotation discarded";
			}
		} else {
			this.annotationController.upsert(modal.target, trimmed);
			this.lastActionMessage = existing ? "annotation updated" : "annotation added";
		}
		this.closeAnnotationModal();
	}

	private cancelAnnotationModal(): void {
		this.closeAnnotationModal();
	}

	private closeAnnotationModal(): void {
		this.annotationModal = undefined;
		this.selectionAnchorLineIndex = null;
		this.tui.requestRender();
	}

	private createAnnotationTarget(): CodeAnnotationTarget | undefined {
		const row = this.getSelectedRow();
		const cached = this.getLoadedPreviewForSelection();
		if (!row || row.node.kind !== "file" || !cached || cached.type !== "text") return undefined;
		if (cached.plainLines.length === 0) return undefined;
		const range = this.getSelectedLineRange(cached.plainLines.length);
		return {
			view: "code",
			rootPath: this.rootPath,
			path: row.node.path,
			startLine: range.start + 1,
			endLine: range.end + 1,
			excerpt: cached.plainLines.slice(range.start, range.end + 1),
		};
	}

	private toggleRangeAnchor(): void {
		const cached = this.getLoadedPreviewForSelection();
		if (!cached || cached.type !== "text") return;
		this.clampSelectedLine(cached.plainLines.length);
		if (this.selectionAnchorLineIndex != null) {
			this.selectionAnchorLineIndex = null;
			this.lastActionMessage = undefined;
		} else {
			this.selectionAnchorLineIndex = this.selectedLineIndex;
			this.lastActionMessage = describeAnnotationTarget(this.createAnnotationTarget()!);
		}
		this.tui.requestRender();
	}

	private moveContentLine(delta: number): void {
		const row = this.getSelectedRow();
		const cached = this.getLoadedPreviewForSelection();
		const previewKey = this.previewKeyForSelectedPath();
		if (!row || row.node.kind !== "file" || !cached || cached.type !== "text" || !previewKey) return;
		this.clampSelectedLine(cached.plainLines.length);
		this.selectedLineIndex = Math.max(0, Math.min(cached.plainLines.length - 1, this.selectedLineIndex + delta));
		const model = this.getPreviewModel(cached, this.currentRightPaneWidth(), row.node.path, previewKey);
		this.ensureSelectedPreviewLineVisible(model, this.previewViewportHeight());
		this.tui.requestRender();
	}

	private moveContentToBoundary(boundary: "start" | "end"): void {
		const row = this.getSelectedRow();
		const cached = this.getLoadedPreviewForSelection();
		const previewKey = this.previewKeyForSelectedPath();
		if (!row || row.node.kind !== "file" || !cached || cached.type !== "text" || !previewKey) return;
		this.selectedLineIndex = boundary === "start" ? 0 : Math.max(0, cached.plainLines.length - 1);
		const model = this.getPreviewModel(cached, this.currentRightPaneWidth(), row.node.path, previewKey);
		this.ensureSelectedPreviewLineVisible(model, this.previewViewportHeight());
		this.tui.requestRender();
	}

	private expandOrToggleDirectory(expand: boolean): void {
		const row = this.getSelectedRow();
		if (!row) return;

		if (row.node.kind === "dir") {
			const isCollapsed = this.collapsedDirs.has(row.node.path);
			if (expand && isCollapsed) {
				this.collapsedDirs.delete(row.node.path);
				this.rebuildVisibleRows(row.node.path);
				this.tui.requestRender();
				return;
			}
			if (!expand && !isCollapsed) {
				this.collapsedDirs.add(row.node.path);
				this.rebuildVisibleRows(row.node.path);
				this.tui.requestRender();
				return;
			}
			if (!expand && row.node.parentPath) {
				this.selectPath(row.node.parentPath);
				return;
			}
			return;
		}

		if (!expand && row.node.parentPath) this.selectPath(row.node.parentPath);
	}

	private selectPath(targetPath: string): void {
		const nextIndex = this.findVisibleIndex(targetPath);
		if (nextIndex < 0) return;
		const previous = this.selectedPath;
		this.selectedIndex = nextIndex;
		this.selectedPath = targetPath;
		if (this.selectedPath !== previous) {
			this.previewScroll = 0;
			this.lastSelectedPreviewKey = undefined;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
		}
		this.ensureTreeSelectionVisible(this.previewViewportHeight());
		this.tui.requestRender();
	}

	private findVisibleIndex(targetPath: string): number {
		return this.visibleRows.findIndex((row) => row.node.path === targetPath);
	}

	private firstSelectableIndex(): number {
		const fileIndex = this.visibleRows.findIndex((row) => row.node.kind === "file");
		return fileIndex >= 0 ? fileIndex : 0;
	}

	private visibleHostHeight(width = this.tui.terminal.columns): number {
		return getVisibleHostHeight(this.tui, this, width);
	}

	private previewViewportHeight(width = this.tui.terminal.columns): number {
		return Math.max(1, this.visibleHostHeight(width) - HEADER_LINES - FOOTER_LINES - PANE_HEADER_LINES);
	}

	private previewPageStep(): number {
		return Math.max(1, Math.round(this.previewViewportHeight() * PAGE_SCROLL_RATIO));
	}

	private ensureTreeSelectionVisible(viewHeight: number): void {
		if (this.visibleRows.length === 0) {
			this.treeScroll = 0;
			return;
		}
		if (this.selectedIndex < this.treeScroll) this.treeScroll = this.selectedIndex;
		else if (this.selectedIndex >= this.treeScroll + viewHeight) this.treeScroll = this.selectedIndex - viewHeight + 1;

		const maxScroll = Math.max(0, this.visibleRows.length - viewHeight);
		if (this.treeScroll > maxScroll) this.treeScroll = maxScroll;
		if (this.treeScroll < 0) this.treeScroll = 0;
	}

	private ensureSelectedPreviewLineVisible(model: WrappedRenderModel, height: number): void {
		if (model.selectedStart == null || model.selectedEnd == null) return;
		if (model.selectedStart < this.previewScroll) this.previewScroll = model.selectedStart;
		else if (model.selectedEnd >= this.previewScroll + height) this.previewScroll = model.selectedEnd - height + 1;
	}

	private scrollPreviewBy(delta: number): void {
		this.previewScroll = Math.max(0, this.previewScroll + delta);
		this.tui.requestRender();
	}

	private clampSelectedLine(totalLines: number): void {
		if (totalLines <= 0) {
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
			return;
		}
		this.selectedLineIndex = Math.max(0, Math.min(totalLines - 1, this.selectedLineIndex));
		if (this.selectionAnchorLineIndex != null) {
			this.selectionAnchorLineIndex = Math.max(0, Math.min(totalLines - 1, this.selectionAnchorLineIndex));
		}
	}

	private getSelectedLineRange(totalLines: number): { start: number; end: number } {
		this.clampSelectedLine(totalLines);
		const anchor = this.selectionAnchorLineIndex ?? this.selectedLineIndex;
		return {
			start: Math.min(anchor, this.selectedLineIndex),
			end: Math.max(anchor, this.selectedLineIndex),
		};
	}

	private currentRangeLabel(): string | undefined {
		const cached = this.getLoadedPreviewForSelection();
		if (!cached || cached.type !== "text" || !this.isContentPaneActive()) return undefined;
		const range = this.getSelectedLineRange(cached.plainLines.length);
		return range.start === range.end ? `line ${range.start + 1}` : `lines ${range.start + 1}-${range.end + 1}`;
	}
}
