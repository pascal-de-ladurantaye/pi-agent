import path from "node:path";

import type { ExtensionAPI, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { renderDiff } from "@mariozechner/pi-coding-agent";
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
import { countDiffAnnotationsForRef, describeAnnotationTarget } from "../lib/annotations";
import {
	type AnnotationModalState,
	computeAnnotationModalWidth,
	createAnnotationModal,
	overlayAnnotationModal,
} from "./annotation-modal";
import { loadDeltaDiff, loadPiDiff, parsePiDiffLines } from "../lib/diff";
import { detectDelta, diffMetadataLines, resolveBranchName, runGitDiff } from "../lib/git";
import { getVisibleHostHeight } from "../lib/host-layout";
import { fitLine, renderFileBadges, replaceTabs, splitAnsiLines, wrapAnsiLines } from "../lib/render";
import {
	renderShortcutFooterLine,
	renderShortcutHelp,
	renderShortcutHint,
	type ShortcutHintAction,
	type ShortcutKeySpec,
} from "../lib/shortcut-ui";
import { buildTree, emptyStats, flattenTree, matchesFilter, parseStatusPorcelainV1Z } from "../lib/tree";
import type {
	AggregateStats,
	ChangedFile,
	DiffAnnotationTarget,
	DiffScope,
	DiffViewerState,
	DirNode,
	FileFilter,
	LoadedDiff,
	PreferredRenderer,
	TreeNode,
	ViewerAnnotationController,
	ViewerPane,
	ViewerResult,
	VisibleTreeRow,
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

interface DiffShortcutAction extends ShortcutHintAction {
	match(data: string): boolean;
	run(data: string): void;
}

export class DiffViewerComponent implements Component, Focusable {
	private readonly repoName: string;
	private readonly annotationController: ViewerAnnotationController;
	private readonly initialSelectedPath?: string;
	private branchName?: string;
	private preferredRenderer: PreferredRenderer = "pi";
	private loading = true;
	private refreshing = false;
	private errorMessage?: string;
	private allEntries: ChangedFile[] = [];
	private filter: FileFilter;
	private diffScopePreference: DiffScope;
	private treePaneVisible: boolean;
	private activePane: ViewerPane;
	private selectedLineIndex: number;
	private selectionAnchorLineIndex: number | null;
	private pendingFocusRef?: string;
	private treeRoot: DirNode = buildTree([]);
	private visibleRows: VisibleTreeRow[] = [];
	private collapsedDirs: Set<string>;
	private selectedPath: string | null = null;
	private selectedIndex = 0;
	private treeScroll = 0;
	private diffScroll = 0;
	private lastSelectedDiffKey?: string;
	private diffCache = new Map<string, LoadedDiff>();
	private cachedParsedDiff?: { key: string; parsed: ReturnType<typeof parsePiDiffLines> };
	private cachedAnnotatableDiffModel?: { key: string; model: WrappedRenderModel };
	private loadingDiffKey?: string;
	private refreshToken = 0;
	private lastActionMessage?: string;
	private annotationModal?: AnnotationModalState<DiffAnnotationTarget>;
	private showHelp = false;
	private _focused = false;
	private closed = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly repoRoot: string,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: ViewerResult | undefined) => void,
		options: {
			state?: DiffViewerState;
			annotationController: ViewerAnnotationController;
		},
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.repoName = path.basename(repoRoot);
		this.annotationController = options.annotationController;
		this.initialSelectedPath = options.state?.selectedPath;
		this.filter = options.state?.filter ?? "all";
		this.diffScopePreference = options.state?.diffScopePreference ?? "unstaged";
		this.treePaneVisible = options.state?.treePaneVisible ?? true;
		this.activePane = options.state?.activePane ?? "tree";
		this.selectedLineIndex = Math.max(0, options.state?.selectedLineIndex ?? 0);
		this.selectionAnchorLineIndex = options.state?.selectionAnchorLineIndex ?? null;
		this.pendingFocusRef = options.state?.focusRef;
		this.collapsedDirs = new Set(options.state?.collapsedDirs ?? []);
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
		this.cachedParsedDiff = undefined;
		this.cachedAnnotatableDiffModel = undefined;
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
			const filteredCount = this.treeRoot.aggregate.fileCount;
			const leftTitle =
				this.theme.fg("accent", this.theme.bold(`Files (${filteredCount})`)) +
				this.theme.fg("muted", ` · ${this.filter}`) +
				(this.isContentPaneActive() ? this.theme.fg("accent", " · focus diff") : "");
			lines.push(fitLine(leftTitle, leftWidth) + separator + fitLine(rightTitle, rightWidth));

			const leftLines = this.renderTreeLines(leftWidth, paneContentHeight);
			let rightLines = this.renderDiffLines(rightWidth, paneContentHeight);
			if (this.annotationModal) rightLines = this.renderAnnotationModalIntoPane(rightLines, rightWidth);
			for (let i = 0; i < paneContentHeight; i++) {
				lines.push((leftLines[i] ?? " ".repeat(leftWidth)) + separator + (rightLines[i] ?? " ".repeat(rightWidth)));
			}
		} else {
			lines.push(fitLine(rightTitle, rightWidth));
			let rightLines = this.renderDiffLines(rightWidth, paneContentHeight);
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

	private switchView(view: "code"): void {
		if (this.closed) return;
		this.closed = true;
		this.done({ action: "switch", view, state: this.snapshotState() });
	}

	private snapshotState(): DiffViewerState {
		return {
			view: "diff",
			selectedPath: this.selectedPath ?? undefined,
			collapsedDirs: [...this.collapsedDirs],
			treePaneVisible: this.treePaneVisible,
			activePane: this.isTreePaneRendered() ? this.activePane : "content",
			selectedLineIndex: this.selectedLineIndex,
			selectionAnchorLineIndex: this.selectionAnchorLineIndex ?? undefined,
			filter: this.filter,
			diffScopePreference: this.diffScopePreference,
		};
	}

	private async initialize(): Promise<void> {
		try {
			this.preferredRenderer = (await detectDelta(this.pi, this.repoRoot)) ? "delta" : "pi";
			this.branchName = await resolveBranchName(this.pi, this.repoRoot);
			await this.reloadStatus(false);
		} catch (error) {
			this.loading = false;
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		}
	}

	private async reloadStatus(preserveSelection: boolean): Promise<void> {
		const refreshToken = ++this.refreshToken;
		const preferredPath = preserveSelection ? this.selectedPath ?? this.initialSelectedPath : this.initialSelectedPath;
		if (this.loading) this.errorMessage = undefined;
		else this.refreshing = true;
		this.tui.requestRender();

		try {
			const [statusOutput, branchName] = await Promise.all([
				runGitDiff(this.pi, this.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
				resolveBranchName(this.pi, this.repoRoot),
			]);
			if (this.closed || refreshToken !== this.refreshToken) return;

			this.branchName = branchName;
			this.allEntries = parseStatusPorcelainV1Z(statusOutput);
			this.diffCache.clear();
			this.cachedParsedDiff = undefined;
			this.cachedAnnotatableDiffModel = undefined;
			this.loadingDiffKey = undefined;
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
		this.treeRoot = buildTree(this.allEntries.filter((entry) => matchesFilter(entry, this.filter)));
		this.visibleRows = flattenTree(this.treeRoot, this.collapsedDirs);

		let nextIndex = this.firstSelectableIndex();
		if (previousPath) {
			const match = this.findVisibleIndex(previousPath);
			if (match >= 0) nextIndex = match;
		}

		this.selectedIndex = this.visibleRows.length === 0 ? 0 : Math.max(0, Math.min(nextIndex, this.visibleRows.length - 1));
		this.selectedPath = this.visibleRows[this.selectedIndex]?.node.path ?? null;
		if (this.selectedPath !== oldSelectedPath) {
			this.diffScroll = 0;
			this.lastSelectedDiffKey = undefined;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
		}
		if (this.getSelectedRow()?.node.kind !== "file" && this.activePane === "content") this.activePane = "tree";
		this.ensureTreeSelectionVisible(this.diffViewportHeight());
	}

	private computeOverallStats(): AggregateStats {
		const stats = emptyStats();
		for (const entry of this.allEntries) {
			stats.fileCount += 1;
			if (entry.staged) stats.stagedCount += 1;
			if (entry.unstaged) stats.unstagedCount += 1;
			if (entry.untracked) stats.untrackedCount += 1;
			if (entry.conflicted) stats.conflictedCount += 1;
			if (entry.renamed) stats.renamedCount += 1;
		}
		return stats;
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
			this.theme.fg("muted", " · diff · ") +
			this.theme.fg("text", this.repoName) +
			(this.branchName ? this.theme.fg("muted", ` (${this.branchName})`) : "") +
			(this.showHelp ? this.theme.fg("accent", " · help") : "");

		let subtitle: string;
		if (this.errorMessage) {
			subtitle = this.theme.fg("error", this.errorMessage);
		} else {
			const stats = this.computeOverallStats();
			const annotationCount = this.annotationController.list().length;
			const renderer = this.theme.fg(this.preferredRenderer === "delta" ? "accent" : "success", this.preferredRenderer);
			subtitle =
				this.theme.fg("muted", "renderer ") +
				renderer +
				this.theme.fg("muted", ` · files ${stats.fileCount} · staged ${stats.stagedCount} · unstaged ${stats.unstagedCount}`);
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
			if (stats.untrackedCount > 0) subtitle += this.theme.fg("muted", ` · untracked ${stats.untrackedCount}`);
			if (stats.conflictedCount > 0) subtitle += this.theme.fg("error", ` · conflicts ${stats.conflictedCount}`);
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
			? "Diff-line shortcuts shown for the selected patch."
			: "Tree shortcuts shown for the changed-file explorer.";
		return renderShortcutHelp(this.theme, this.keybindings, width, height, "Diff view shortcuts", subtitle, this.shortcutActions());
	}

	private shortcutActions(): DiffShortcutAction[] {
		const row = this.getSelectedRow();
		const isContent = this.isContentPaneActive();
		const canSwitchPane = this.canSwitchPane();
		const annotatable = this.hasAnnotatableSelection();
		const rangeActive = this.selectionAnchorLineIndex != null;
		const canToggleScope = this.canToggleScope();
		const annotationCount = this.annotationController.list().length;
		const actions: DiffShortcutAction[] = [];

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
				helpLabel: "move the selected diff line",
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
							? "clear the active diff range and return to single-line selection"
							: "start selecting a diff range from the current line",
						section: "Annotate",
						footerRow: 1,
						match: (data) => matchesKey(data, "space"),
						run: () => this.toggleRangeAnchor(),
					},
					{
						id: "annotate",
						keys: [{ kind: "raw", value: "a" }],
						footerLabel: "annotate",
						helpLabel: "edit the annotation for the current diff line or range",
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
					helpLabel: "return focus to the changed-file tree",
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
				helpLabel: "move the changed-file selection",
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
						helpLabel: row.node.kind === "file" ? "open the diff and focus content" : "expand the selected directory",
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
				helpLabel: isContent ? "scroll by page and keep the selected line visible" : "scroll the diff preview by page",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.pageUp")) {
						if (isContent) this.moveContentLine(-this.diffPageStep());
						else this.scrollDiffBy(-this.diffPageStep());
					} else if (isContent) this.moveContentLine(this.diffPageStep());
					else this.scrollDiffBy(this.diffPageStep());
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
							this.diffScroll = 0;
							this.tui.requestRender();
						}
					} else if (isContent) this.moveContentToBoundary("end");
					else {
						this.diffScroll = Number.MAX_SAFE_INTEGER;
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
				helpLabel: "switch between the changed-file tree and diff panes",
				section: "Navigate",
				footerRow: 2,
				match: (data) => matchesKey(data, "tab"),
				run: () => this.toggleActivePane(),
			});
		}

		if (canToggleScope) {
			actions.push({
				id: "scope",
				keys: [{ kind: "raw", value: "s" }],
				footerLabel: "scope",
				helpLabel: "toggle between staged and unstaged diff scopes",
				section: "Diff",
				footerRow: 2,
				match: (data) => matchesKey(data, "s"),
				run: () => this.toggleDiffScopePreference(),
			});
		}

		actions.push({
			id: "filter",
			keys: [{ kind: "raw", value: "f" }],
			footerLabel: "filter",
			helpLabel: "cycle file filter between all, staged, and unstaged",
			section: "Diff",
			footerRow: 2,
			match: (data) => matchesKey(data, "f"),
			run: () => this.cycleFilter(),
		});

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
						this.closed = true;
						this.done({ action: "notes", state: this.snapshotState() });
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
						this.closed = true;
						this.done({ action: "draft", state: this.snapshotState() });
					},
				},
			);
		}

		actions.push(
			{
				id: "switch-view",
				keys: [{ kind: "raw", value: "v" }],
				footerLabel: "code view",
				helpLabel: "switch to the code view",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "v"),
				run: () => this.switchView("code"),
			},
			{
				id: "toggle-tree",
				keys: [{ kind: "raw", value: "t" }],
				footerLabel: "tree",
				helpLabel: "toggle the changed-file tree pane",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "t"),
				run: () => this.toggleTreePane(),
			},
			{
				id: "refresh",
				keys: [{ kind: "raw", value: "r" }],
				footerLabel: "refresh",
				helpLabel: "reload git status and diff metadata",
				section: "View",
				footerRow: 2,
				match: (data) => matchesKey(data, "r"),
				run: () => {
					void this.reloadStatus(true);
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
		return this.currentAnnotatableSelection() != null;
	}

	private canToggleScope(): boolean {
		const row = this.getSelectedRow();
		return Boolean(row && row.node.kind === "file" && this.filter === "all" && row.node.entry.staged && row.node.entry.unstaged);
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

	private currentAnnotatableSelection(): {
		entry: ChangedFile;
		scope: DiffScope;
		key: string;
		cached: Extract<LoadedDiff, { type: "pi" }>;
		parsed: ReturnType<typeof parsePiDiffLines>;
	} | undefined {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return undefined;
		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) return undefined;
		const key = this.currentDiffCacheKey(row.node.entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return undefined;
		const parsed = this.getParsedDiffLines(cached, key);
		if (parsed.length === 0) return undefined;
		return { entry: row.node.entry, scope, key, cached, parsed };
	}

	private renderRightPaneTitle(width: number): string {
		const row = this.getSelectedRow();
		if (!row) return this.theme.fg("muted", "Diff");
		if (row.node.kind === "dir") {
			const label = row.node.path || this.repoName;
			return this.theme.fg("accent", this.theme.bold(label)) + this.theme.fg("muted", " · summary");
		}

		const scope = this.effectiveScopeFor(row.node.entry);
		const scopeColor = scope === "staged" ? "success" : "warning";
		const title = this.theme.fg("accent", this.theme.bold(row.node.path));
		const range = this.currentRangeLabel(row.node.entry, scope);
		const suffix = scope ? this.theme.fg(scopeColor, ` · ${scope}`) : this.theme.fg("muted", " · diff");
		const rangeSuffix = this.isContentPaneActive() && range ? this.theme.fg("accent", ` · ${range}`) : "";
		return truncateToWidth(title + suffix + rangeSuffix, width);
	}

	private renderTreeLines(width: number, height: number): string[] {
		if (width <= 0) return new Array(height).fill("");
		if (this.loading && this.visibleRows.length === 0) {
			return this.fillVertical([this.theme.fg("muted", "Loading git status…")], width, height);
		}
		if (this.visibleRows.length === 0) {
			const message = this.filter === "all" ? "Working tree clean" : `No ${this.filter} changes`;
			return this.fillVertical([this.theme.fg("muted", message)], width, height);
		}

		this.ensureTreeSelectionVisible(height);
		const end = Math.min(this.visibleRows.length, this.treeScroll + height);
		const slice = this.visibleRows.slice(this.treeScroll, end);
		const lines = slice.map((row, index) => this.renderTreeRow(row, width, this.treeScroll + index === this.selectedIndex));
		return this.fillVertical(lines, width, height, true);
	}

	private renderTreeRow(row: VisibleTreeRow, width: number, selected: boolean): string {
		const indent = "  ".repeat(row.depth);
		const icon =
			row.node.kind === "dir"
				? this.collapsedDirs.has(row.node.path)
					? this.theme.fg("muted", "▸")
					: this.theme.fg("muted", "▾")
				: this.theme.fg("muted", "•");
		const label = this.theme.fg("text", row.node.name);
		const badges = renderFileBadges(this.theme, row.node.kind === "dir" ? row.node.aggregate : row.node.entry);
		const line = `${indent}${icon} ${label}${badges}`;
		const fitted = fitLine(line, width);
		return selected ? this.theme.bg("selectedBg", fitted) : fitted;
	}

	private renderDiffLines(width: number, height: number): string[] {
		if (width <= 0) return new Array(height).fill("");
		if (this.loading) {
			return this.fillVertical([this.theme.fg("muted", "Loading diff view…")], width, height);
		}
		if (this.errorMessage && this.allEntries.length === 0) {
			return this.fillVertical([this.theme.fg("error", this.errorMessage)], width, height);
		}

		const row = this.getSelectedRow();
		if (!row) {
			return this.fillVertical([this.theme.fg("muted", "No modified files to preview.")], width, height);
		}
		if (row.node.kind === "dir") {
			return this.renderDirectorySummary(row.node, width, height);
		}

		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) {
			return this.fillVertical([this.theme.fg("muted", "No diff available for the selected file.")], width, height);
		}

		if (this.isContentPaneActive()) return this.renderAnnotatableDiffLines(width, height, row.node.entry, scope);
		return this.renderBrowseDiffLines(width, height, row.node.entry, scope);
	}

	private renderBrowseDiffLines(width: number, height: number, entry: ChangedFile, scope: DiffScope): string[] {
		const key = this.currentDiffCacheKey(entry, scope, width);
		if (this.lastSelectedDiffKey !== key) {
			this.lastSelectedDiffKey = key;
			this.diffScroll = 0;
			this.selectionAnchorLineIndex = null;
		}
		this.maybeStartDiffLoad(entry, scope, width, key, this.preferredRenderer);

		const cached = this.diffCache.get(key);
		if (!cached) {
			const rendererLabel = this.preferredRenderer === "delta" ? "delta" : "Pi";
			return this.fillVertical([this.theme.fg("muted", `Loading ${rendererLabel} preview…`)], width, height);
		}

		const rawLines: string[] = [];
		if (cached.type === "delta") {
			for (const line of cached.metadataLines) rawLines.push(this.theme.fg("muted", line));
			if (cached.metadataLines.length > 0) rawLines.push("");
			rawLines.push(...splitAnsiLines(cached.output));
		} else if (cached.type === "pi") {
			for (const line of cached.metadataLines) rawLines.push(this.theme.fg("muted", line));
			if (cached.metadataLines.length > 0) rawLines.push("");
			rawLines.push(...splitAnsiLines(renderDiff(cached.diffText)));
		} else {
			for (const line of cached.metadataLines) rawLines.push(this.theme.fg("muted", line));
			if (cached.metadataLines.length > 0) rawLines.push("");
			for (let i = 0; i < cached.lines.length; i++) {
				rawLines.push(i === 0 ? this.theme.fg("warning", cached.lines[i]!) : this.theme.fg("muted", cached.lines[i]!));
			}
		}

		const wrapped = wrapAnsiLines(rawLines.map((line) => replaceTabs(line)), width);
		const maxScroll = Math.max(0, wrapped.length - height);
		if (this.diffScroll > maxScroll) this.diffScroll = maxScroll;
		if (this.diffScroll < 0) this.diffScroll = 0;
		const visible = wrapped.slice(this.diffScroll, this.diffScroll + height).map((line) => fitLine(line, width));
		return this.fillVertical(visible, width, height, true);
	}

	private renderAnnotatableDiffLines(width: number, height: number, entry: ChangedFile, scope: DiffScope): string[] {
		const key = this.currentDiffCacheKey(entry, scope, width, "annotate");
		if (this.lastSelectedDiffKey !== key) {
			this.lastSelectedDiffKey = key;
			this.diffScroll = 0;
			this.selectionAnchorLineIndex = null;
		}
		this.maybeStartDiffLoad(entry, scope, width, key, "pi");

		const cached = this.diffCache.get(key);
		if (!cached) return this.fillVertical([this.theme.fg("muted", "Loading annotatable diff…")], width, height);
		if (cached.type !== "pi") {
			const rawLines: string[] = [];
			for (const line of cached.metadataLines) rawLines.push(this.theme.fg("muted", line));
			if (cached.metadataLines.length > 0) rawLines.push("");
			if (cached.type === "delta") rawLines.push(...splitAnsiLines(cached.output));
			else {
				for (let i = 0; i < cached.lines.length; i++) {
					rawLines.push(i === 0 ? this.theme.fg("warning", cached.lines[i]!) : this.theme.fg("muted", cached.lines[i]!));
				}
			}
			const wrapped = wrapAnsiLines(rawLines, width);
			const maxScroll = Math.max(0, wrapped.length - height);
			if (this.diffScroll > maxScroll) this.diffScroll = maxScroll;
			const visible = wrapped.slice(this.diffScroll, this.diffScroll + height).map((line) => fitLine(line, width));
			return this.fillVertical(visible, width, height, true);
		}

		const parsed = this.getParsedDiffLines(cached, key);
		this.applyPendingFocusRef(parsed);
		this.clampSelectedLine(parsed.length);
		const model = this.getAnnotatableDiffModel(cached, parsed, entry, scope, width, key);
		this.ensureSelectedDiffLineVisible(model, height);
		const maxScroll = Math.max(0, model.rows.length - height);
		if (this.diffScroll > maxScroll) this.diffScroll = maxScroll;
		if (this.diffScroll < 0) this.diffScroll = 0;
		const visible = model.rows
			.slice(this.diffScroll, this.diffScroll + height)
			.map((rowModel) => (rowModel.selected ? this.theme.bg("selectedBg", fitLine(rowModel.text, width)) : fitLine(rowModel.text, width)));
		return this.fillVertical(visible, width, height, true);
	}

	private renderAnnotationModalIntoPane(baseLines: string[], paneWidth: number): string[] {
		if (!this.annotationModal) return baseLines;
		const modalWidth = computeAnnotationModalWidth(paneWidth);
		return overlayAnnotationModal(baseLines, paneWidth, this.annotationModal.editor.render(modalWidth));
	}

	private buildAnnotatableDiffModel(
		cached: Extract<LoadedDiff, { type: "pi" }>,
		parsed: ReturnType<typeof parsePiDiffLines>,
		entry: ChangedFile,
		scope: DiffScope,
		width: number,
	): WrappedRenderModel {
		const logicalLines: RenderLineModel[] = [];
		for (const line of cached.metadataLines) logicalLines.push({ text: this.theme.fg("muted", line), selected: false });
		if (cached.metadataLines.length > 0) logicalLines.push({ text: "", selected: false });

		const renderedLines = splitAnsiLines(renderDiff(cached.diffText));
		const range = this.getSelectedLineRange(parsed.length);
		const annotations = this.annotationController.list();
		for (let index = 0; index < renderedLines.length; index++) {
			const parsedLine = parsed[index];
			const annotationCount = countDiffAnnotationsForRef(annotations, this.repoRoot, entry.path, scope, parsedLine?.ref);
			const selected = this.isContentPaneActive() && index === this.selectedLineIndex;
			const inRange = this.isContentPaneActive() && index >= range.start && index <= range.end;
			const markerChar = selected ? "›" : inRange ? "│" : annotationCount > 0 ? String(Math.min(annotationCount, 9)) : " ";
			const markerColor = selected || inRange || annotationCount > 0 ? "accent" : "dim";
			const marker = this.theme.fg(markerColor, `${markerChar} `);
			logicalLines.push({ text: `${marker}${replaceTabs(renderedLines[index] ?? "")}`, selected });
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

	private applyPendingFocusRef(parsed: ReturnType<typeof parsePiDiffLines>): void {
		if (!this.pendingFocusRef) return;
		const targetRef = this.pendingFocusRef;
		this.pendingFocusRef = undefined;
		const index = parsed.findIndex((line) => line.ref === targetRef);
		if (index < 0) return;
		this.selectedLineIndex = index;
		this.selectionAnchorLineIndex = null;
	}

	private getParsedDiffLines(
		cached: Extract<LoadedDiff, { type: "pi" }>,
		diffKey: string,
	): ReturnType<typeof parsePiDiffLines> {
		if (this.cachedParsedDiff?.key === diffKey) return this.cachedParsedDiff.parsed;
		const parsed = parsePiDiffLines(cached.diffText);
		this.cachedParsedDiff = { key: diffKey, parsed };
		return parsed;
	}

	private getAnnotatableDiffModel(
		cached: Extract<LoadedDiff, { type: "pi" }>,
		parsed: ReturnType<typeof parsePiDiffLines>,
		entry: ChangedFile,
		scope: DiffScope,
		width: number,
		diffKey: string,
	): WrappedRenderModel {
		const modelKey = [
			diffKey,
			String(width),
			this.isContentPaneActive() ? "content" : "tree",
			String(this.selectedLineIndex),
			String(this.selectionAnchorLineIndex ?? ""),
			this.diffAnnotationSignature(entry, scope),
		].join("|");
		if (this.cachedAnnotatableDiffModel?.key === modelKey) return this.cachedAnnotatableDiffModel.model;

		const model = this.buildAnnotatableDiffModel(cached, parsed, entry, scope, width);
		this.cachedAnnotatableDiffModel = { key: modelKey, model };
		return model;
	}

	private diffAnnotationSignature(entry: ChangedFile, scope: DiffScope): string {
		const ids: string[] = [];
		for (const annotation of this.annotationController.list()) {
			const target = annotation.target;
			if (target.view !== "diff") continue;
			if (target.repoRoot !== this.repoRoot || target.path !== entry.path || target.scope !== scope) continue;
			ids.push(annotation.id);
		}
		return ids.join(",");
	}

	private renderDirectorySummary(node: DirNode, width: number, height: number): string[] {
		const descendantFiles = this.collectDescendantFiles(node, 6);
		const lines: string[] = [
			this.theme.fg("accent", this.theme.bold(node.path || this.repoName)),
			this.theme.fg("muted", `${node.aggregate.fileCount} changed files`),
			this.theme.fg(
				"muted",
				`${node.aggregate.stagedCount} staged · ${node.aggregate.unstagedCount} unstaged · ${node.aggregate.untrackedCount} untracked`,
			),
			"",
			this.theme.fg("muted", "Select a file and press Enter to open its diff."),
		];

		if (descendantFiles.length > 0) {
			lines.push("");
			lines.push(this.theme.fg("muted", "Examples:"));
			for (const descendant of descendantFiles) {
				lines.push(`• ${descendant.path}${renderFileBadges(this.theme, descendant)}`);
			}
		}

		return this.fillVertical(lines.map((line) => fitLine(line, width)), width, height, true);
	}

	private collectDescendantFiles(node: DirNode, limit: number): ChangedFile[] {
		const results: ChangedFile[] = [];
		const stack: TreeNode[] = [...node.children];
		while (stack.length > 0 && results.length < limit) {
			const current = stack.shift()!;
			if (current.kind === "file") results.push(current.entry);
			else stack.unshift(...current.children);
		}
		return results;
	}

	private fillVertical(lines: string[], width: number, height: number, alreadyFitted = false): string[] {
		const output = lines.slice(0, height).map((line) => (alreadyFitted ? line : fitLine(line, width)));
		while (output.length < height) output.push(" ".repeat(width));
		return output;
	}

	private getSelectedRow(): VisibleTreeRow | undefined {
		return this.visibleRows[this.selectedIndex];
	}

	private effectiveScopeFor(entry: ChangedFile): DiffScope | undefined {
		if (this.filter === "staged") return entry.staged ? "staged" : undefined;
		if (this.filter === "unstaged") return entry.unstaged ? "unstaged" : undefined;
		if (entry.staged && entry.unstaged) return this.diffScopePreference;
		if (entry.unstaged) return "unstaged";
		if (entry.staged) return "staged";
		return undefined;
	}

	private currentDiffCacheKey(entry: ChangedFile, scope: DiffScope, width: number, mode: "browse" | "annotate" = "browse"): string {
		if (mode === "annotate") return `${this.refreshToken}|annotate|${scope}|${entry.path}`;
		if (this.preferredRenderer === "delta") return `${this.refreshToken}|delta|${width}|${scope}|${entry.path}`;
		return `${this.refreshToken}|pi|${scope}|${entry.path}`;
	}

	private maybeStartDiffLoad(
		entry: ChangedFile,
		scope: DiffScope,
		width: number,
		key: string,
		renderer: PreferredRenderer,
	): void {
		if (this.diffCache.has(key) || this.loadingDiffKey === key) return;
		this.loadingDiffKey = key;
		void this.loadDiffForKey(entry, scope, width, key, renderer);
	}

	private async loadDiffForKey(
		entry: ChangedFile,
		scope: DiffScope,
		width: number,
		key: string,
		renderer: PreferredRenderer,
	): Promise<void> {
		const refreshToken = this.refreshToken;
		try {
			let loaded: LoadedDiff;
			if (renderer === "delta") {
				try {
					loaded = await loadDeltaDiff(this.pi, this.repoRoot, entry, scope, width);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					loaded = await loadPiDiff(this.pi, this.repoRoot, entry, scope, `delta fallback: ${reason}`);
				}
			} else {
				loaded = await loadPiDiff(this.pi, this.repoRoot, entry, scope);
			}

			if (this.closed || refreshToken !== this.refreshToken) return;
			this.diffCache.set(key, loaded);
		} catch (error) {
			if (this.closed || refreshToken !== this.refreshToken) return;
			this.diffCache.set(key, {
				type: "message",
				metadataLines: diffMetadataLines(entry, scope),
				lines: [error instanceof Error ? error.message : String(error)],
			});
		} finally {
			if (this.loadingDiffKey === key) this.loadingDiffKey = undefined;
			if (!this.closed && refreshToken === this.refreshToken) this.tui.requestRender();
		}
	}

	private toggleTreePane(): void {
		this.treePaneVisible = !this.treePaneVisible;
		if (!this.treePaneVisible) this.activePane = "content";
		this.tui.requestRender();
	}

	private cycleFilter(): void {
		const order: FileFilter[] = ["all", "staged", "unstaged"];
		const currentIndex = order.indexOf(this.filter);
		this.filter = order[(currentIndex + 1) % order.length]!;
		if (this.filter === "staged") this.diffScopePreference = "staged";
		if (this.filter === "unstaged") this.diffScopePreference = "unstaged";
		this.selectedLineIndex = 0;
		this.selectionAnchorLineIndex = null;
		this.rebuildVisibleRows(this.selectedPath ?? undefined);
		this.tui.requestRender();
	}

	private toggleDiffScopePreference(): void {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return;
		if (this.filter !== "all") return;
		if (!(row.node.entry.staged && row.node.entry.unstaged)) return;
		this.diffScopePreference = this.diffScopePreference === "staged" ? "unstaged" : "staged";
		this.diffScroll = 0;
		this.selectedLineIndex = 0;
		this.selectionAnchorLineIndex = null;
		this.lastSelectedDiffKey = undefined;
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.visibleRows.length === 0) return;
		const previous = this.selectedPath;
		this.selectedIndex = Math.max(0, Math.min(this.visibleRows.length - 1, this.selectedIndex + delta));
		this.selectedPath = this.visibleRows[this.selectedIndex]?.node.path ?? null;
		if (this.selectedPath !== previous) {
			this.diffScroll = 0;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
			this.lastSelectedDiffKey = undefined;
		}
		this.ensureTreeSelectionVisible(this.diffViewportHeight());
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

	private openAnnotationModal(target: DiffAnnotationTarget, prefill?: string): void {
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

	private createAnnotationTarget(): DiffAnnotationTarget | undefined {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return undefined;
		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) return undefined;
		const key = this.currentDiffCacheKey(row.node.entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return undefined;
		const parsed = parsePiDiffLines(cached.diffText);
		if (parsed.length === 0) return undefined;
		const range = this.getSelectedLineRange(parsed.length);
		const selected = parsed.slice(range.start, range.end + 1).filter((line) => line.kind === "diff" && line.ref);
		if (selected.length === 0) return undefined;
		const uniqueSides = [...new Set(selected.map((line) => line.side))];
		return {
			view: "diff",
			repoRoot: this.repoRoot,
			branchName: this.branchName,
			path: row.node.path,
			scope,
			side: uniqueSides.length === 1 ? uniqueSides[0]! : "mixed",
			refs: selected.map((line) => line.ref!),
			excerpt: selected.map((line) => line.raw),
		};
	}

	private toggleRangeAnchor(): void {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return;
		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) return;
		const key = this.currentDiffCacheKey(row.node.entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return;
		const parsed = this.getParsedDiffLines(cached, key);
		this.clampSelectedLine(parsed.length);
		if (this.selectionAnchorLineIndex != null) {
			this.selectionAnchorLineIndex = null;
			this.lastActionMessage = undefined;
		} else {
			this.selectionAnchorLineIndex = this.selectedLineIndex;
			const target = this.createAnnotationTarget();
			this.lastActionMessage = target ? describeAnnotationTarget(target) : undefined;
		}
		this.tui.requestRender();
	}

	private moveContentLine(delta: number): void {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return;
		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) return;
		const key = this.currentDiffCacheKey(row.node.entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return;
		const parsed = this.getParsedDiffLines(cached, key);
		this.clampSelectedLine(parsed.length);
		this.selectedLineIndex = Math.max(0, Math.min(parsed.length - 1, this.selectedLineIndex + delta));
		const model = this.getAnnotatableDiffModel(cached, parsed, row.node.entry, scope, this.currentRightPaneWidth(), key);
		this.ensureSelectedDiffLineVisible(model, this.diffViewportHeight());
		this.tui.requestRender();
	}

	private moveContentToBoundary(boundary: "start" | "end"): void {
		const row = this.getSelectedRow();
		if (!row || row.node.kind !== "file") return;
		const scope = this.effectiveScopeFor(row.node.entry);
		if (!scope) return;
		const key = this.currentDiffCacheKey(row.node.entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return;
		const parsed = this.getParsedDiffLines(cached, key);
		this.selectedLineIndex = boundary === "start" ? 0 : Math.max(0, parsed.length - 1);
		const model = this.getAnnotatableDiffModel(cached, parsed, row.node.entry, scope, this.currentRightPaneWidth(), key);
		this.ensureSelectedDiffLineVisible(model, this.diffViewportHeight());
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
			this.diffScroll = 0;
			this.selectedLineIndex = 0;
			this.selectionAnchorLineIndex = null;
			this.lastSelectedDiffKey = undefined;
		}
		this.ensureTreeSelectionVisible(this.diffViewportHeight());
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

	private diffViewportHeight(width = this.tui.terminal.columns): number {
		return Math.max(1, this.visibleHostHeight(width) - HEADER_LINES - FOOTER_LINES - PANE_HEADER_LINES);
	}

	private diffPageStep(): number {
		return Math.max(1, Math.round(this.diffViewportHeight() * PAGE_SCROLL_RATIO));
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

	private ensureSelectedDiffLineVisible(model: WrappedRenderModel, height: number): void {
		if (model.selectedStart == null || model.selectedEnd == null) return;
		if (model.selectedStart < this.diffScroll) this.diffScroll = model.selectedStart;
		else if (model.selectedEnd >= this.diffScroll + height) this.diffScroll = model.selectedEnd - height + 1;
	}

	private scrollDiffBy(delta: number): void {
		this.diffScroll = Math.max(0, this.diffScroll + delta);
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

	private currentRangeLabel(entry: ChangedFile, scope: DiffScope | undefined): string | undefined {
		if (!scope || !this.isContentPaneActive()) return undefined;
		const key = this.currentDiffCacheKey(entry, scope, this.currentRightPaneWidth(), "annotate");
		const cached = this.diffCache.get(key);
		if (!cached || cached.type !== "pi") return undefined;
		const parsed = this.getParsedDiffLines(cached, key);
		if (parsed.length === 0) return undefined;
		const range = this.getSelectedLineRange(parsed.length);
		const selected = parsed.slice(range.start, range.end + 1).filter((line) => line.kind === "diff" && line.ref);
		if (selected.length === 0) return `block ${range.start + 1}-${range.end + 1}`;
		if (selected.length === 1) return selected[0]!.ref;
		return `${selected[0]!.ref} → ${selected[selected.length - 1]!.ref}`;
	}
}
