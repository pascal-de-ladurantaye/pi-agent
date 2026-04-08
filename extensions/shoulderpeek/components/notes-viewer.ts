import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Focusable, type TUI } from "@mariozechner/pi-tui";

import { FOOTER_LINES, HEADER_LINES } from "../constants";
import { describeAnnotationTarget } from "../lib/annotations";
import { getVisibleHostHeight } from "../lib/host-layout";
import { fitLine, replaceTabs, wrapAnsiLines } from "../lib/render";
import {
	renderShortcutFooterLine,
	renderShortcutHelp,
	renderShortcutHint,
	type ShortcutHintAction,
	type ShortcutKeySpec,
} from "../lib/shortcut-ui";
import {
	type AnnotationModalState,
	computeAnnotationModalWidth,
	createAnnotationModal,
	overlayAnnotationModal,
} from "./annotation-modal";
import type {
	NotesViewerResult,
	NotesViewerState,
	ViewerAnnotation,
	ViewerAnnotationController,
	ViewerAnnotationTarget,
	ViewerView,
} from "../types";

interface NotesShortcutAction extends ShortcutHintAction {
	match(data: string): boolean;
	run(data: string): void;
}

function noteCountLabel(count: number): string {
	return count === 1 ? "1 pending note" : `${count} pending notes`;
}

function annotationBadge(theme: Theme, annotation: ViewerAnnotation): string {
	return annotation.target.view === "code"
		? theme.fg("success", "[CODE]")
		: theme.fg("warning", "[DIFF]");
}

function notePreview(note: string): string {
	return note.replace(/\s+/g, " ").trim() || "(empty note)";
}

export class NotesViewerComponent implements Component, Focusable {
	private selectedIndex: number;
	private scroll = 0;
	private showHelp = false;
	private annotationModal?: AnnotationModalState<ViewerAnnotationTarget>;
	private lastActionMessage?: string;
	private _focused = false;
	private closed = false;

	constructor(
		private readonly sourceView: ViewerView,
		private readonly annotationController: ViewerAnnotationController,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (value: NotesViewerResult) => void,
		options: { state?: NotesViewerState },
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.selectedIndex = Math.max(0, options.state?.selectedIndex ?? 0);
	}

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (value: NotesViewerResult) => void;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.annotationModal) this.annotationModal.editor.focused = value;
	}

	invalidate(): void {
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
		const bodyHeight = Math.max(1, height - HEADER_LINES - FOOTER_LINES);
		const lines = [...this.renderHeader(width)];

		if (this.showHelp) {
			lines.push(...this.renderHelpBody(width, bodyHeight));
			lines.push(...this.renderHelpFooter(width));
			while (lines.length < height) lines.push(" ".repeat(width));
			return lines.slice(0, height).map((line) => fitLine(line, width));
		}

		let bodyLines = this.renderBody(width, bodyHeight);
		if (this.annotationModal) bodyLines = this.renderAnnotationModalIntoBody(bodyLines, width);
		lines.push(...bodyLines);
		lines.push(...this.renderFooter(width));
		while (lines.length < height) lines.push(" ".repeat(width));
		return lines.slice(0, height).map((line) => fitLine(line, width));
	}

	private renderHeader(width: number): string[] {
		const count = this.annotations().length;
		const title =
			this.theme.fg("accent", this.theme.bold("shoulderpeek")) +
			this.theme.fg("muted", " · notes · ") +
			this.theme.fg("text", noteCountLabel(count)) +
			(this.showHelp ? this.theme.fg("accent", " · help") : "");

		let subtitle = this.theme.fg("muted", `opened from ${this.sourceView} view`);
		if (count > 0) subtitle += this.theme.fg("warning", ` · ${count} ready to review`);
		if (this.lastActionMessage) subtitle += this.theme.fg("accent", ` · ${this.lastActionMessage}`);
		return [fitLine(title, width), fitLine(subtitle, width)];
	}

	private renderBody(width: number, height: number): string[] {
		const annotations = this.annotations();
		if (annotations.length === 0) {
			return this.fillVertical(
				[
					this.theme.fg("muted", "No pending notes."),
					this.theme.fg("muted", `Press ${this.keybindings.getKeys("tui.select.cancel")[0] ?? "Esc"} to go back.`),
				],
				width,
				height,
			);
		}

		const separatorLine = this.theme.fg("border", "─".repeat(Math.max(1, width)));
		const detailHeight = this.detailHeight(height);
		const listHeight = Math.max(1, height - detailHeight - 1);
		const detailLines = this.renderSelectedDetail(width, detailHeight);
		const listLines = this.renderList(width, listHeight);
		return [...detailLines, fitLine(separatorLine, width), ...listLines].slice(0, height);
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
			fitLine(this.theme.fg("dim", "Editing the selected note — use the inline editor hints above."), width),
			fitLine(this.theme.fg("dim", "Notes-list shortcuts pause until the editor closes."), width),
		];
	}

	private renderHelpBody(width: number, height: number): string[] {
		return renderShortcutHelp(
			this.theme,
			this.keybindings,
			width,
			height,
			"Pending notes shortcuts",
			"Jump to a note, edit it, delete it, or review all pending notes in the editor.",
			this.shortcutActions(),
		);
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
			fitLine(this.theme.fg("dim", "Close help first, then use Esc/Q to return to shoulderpeek."), width),
		];
	}

	private renderSelectedDetail(width: number, height: number): string[] {
		const annotation = this.selectedAnnotation();
		if (!annotation) return this.fillVertical([], width, height);

		const lines: string[] = [];
		lines.push(
			annotationBadge(this.theme, annotation) +
			this.theme.fg("text", ` ${describeAnnotationTarget(annotation.target)}`),
		);
		const jumpHint: ShortcutHintAction = {
			id: "detail-jump",
			keys: [{ kind: "binding", value: "tui.select.confirm", fallback: "enter" }],
			footerLabel: "jump",
			section: "Actions",
			footerRow: 1,
		};
		const editHint: ShortcutHintAction = {
			id: "detail-edit",
			keys: [{ kind: "raw", value: "e" }],
			footerLabel: "edit",
			section: "Actions",
			footerRow: 1,
		};
		const deleteHint: ShortcutHintAction = {
			id: "detail-delete",
			keys: [{ kind: "raw", value: "x" }],
			footerLabel: "delete",
			section: "Actions",
			footerRow: 1,
		};
		const reviewHint: ShortcutHintAction = {
			id: "detail-review",
			keys: [{ kind: "raw", value: "d" }],
			footerLabel: "review all",
			section: "Actions",
			footerRow: 1,
		};
		lines.push(
			renderShortcutHint(this.theme, this.keybindings, jumpHint) +
				this.theme.fg("muted", " · ") +
				renderShortcutHint(this.theme, this.keybindings, editHint) +
				this.theme.fg("muted", " · ") +
				renderShortcutHint(this.theme, this.keybindings, deleteHint) +
				this.theme.fg("muted", " · ") +
				renderShortcutHint(this.theme, this.keybindings, reviewHint),
		);
		lines.push("");
		lines.push(this.theme.fg("accent", this.theme.bold("Note")));
		lines.push(...wrapAnsiLines(annotation.note.split(/\r?\n/).map((line) => replaceTabs(line)), width));
		lines.push("");
		lines.push(this.theme.fg("muted", "Excerpt"));
		for (const excerptLine of annotation.target.excerpt.slice(0, 4)) {
			lines.push(this.theme.fg("muted", replaceTabs(excerptLine)));
		}
		return this.fillVertical(lines.map((line) => fitLine(line, width)), width, height, true);
	}

	private renderList(width: number, height: number): string[] {
		const annotations = this.annotations();
		if (annotations.length === 0) return this.fillVertical([], width, height);
		this.ensureSelectionVisible(height);
		const end = Math.min(annotations.length, this.scroll + height);
		const slice = annotations.slice(this.scroll, end);
		const lines = slice.map((annotation, index) => this.renderListRow(width, annotation, this.scroll + index === this.selectedIndex));
		return this.fillVertical(lines, width, height, true);
	}

	private renderListRow(width: number, annotation: ViewerAnnotation, selected: boolean): string {
		const marker = selected ? this.theme.fg("accent", "› ") : this.theme.fg("dim", "  ");
		const target = truncateToWidth(describeAnnotationTarget(annotation.target), Math.max(12, Math.floor(width * 0.5)));
		const preview = notePreview(annotation.note);
		const line = `${marker}${annotationBadge(this.theme, annotation)} ${target}${this.theme.fg("muted", " — ")}${this.theme.fg("text", preview)}`;
		const fitted = fitLine(line, width);
		return selected ? this.theme.bg("selectedBg", fitted) : fitted;
	}

	private renderAnnotationModalIntoBody(baseLines: string[], width: number): string[] {
		if (!this.annotationModal) return baseLines;
		const modalWidth = computeAnnotationModalWidth(width);
		return overlayAnnotationModal(baseLines, width, this.annotationModal.editor.render(modalWidth));
	}

	private shortcutActions(): NotesShortcutAction[] {
		const annotations = this.annotations();
		const hasSelection = annotations.length > 0;
		const closeKeys: ShortcutKeySpec[] = [
			{ kind: "binding", value: "tui.select.cancel", fallback: "esc" },
			{ kind: "raw", value: "q" },
		];
		const actions: NotesShortcutAction[] = [
			{
				id: "move",
				keys: [
					{ kind: "binding", value: "tui.select.up", fallback: "up" },
					{ kind: "binding", value: "tui.select.down", fallback: "down" },
				],
				footerLabel: "move",
				helpLabel: "move between pending notes",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.up")) this.moveSelection(-1);
					else this.moveSelection(1);
				},
			},
			{
				id: "page",
				keys: [
					{ kind: "binding", value: "tui.select.pageUp", fallback: "pageUp" },
					{ kind: "binding", value: "tui.select.pageDown", fallback: "pageDown" },
				],
				footerLabel: "page",
				helpLabel: "move through the notes list by page",
				section: "Navigate",
				footerRow: 1,
				match: (data) => this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"),
				run: (data) => {
					if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveSelection(-this.pageStep());
					else this.moveSelection(this.pageStep());
				},
			},
			{
				id: "bounds",
				keys: [{ kind: "raw", value: "home" }, { kind: "raw", value: "end" }],
				footerLabel: "top/btm",
				helpLabel: "jump to the first or last note",
				section: "Navigate",
				footerRow: 1,
				match: (data) => matchesKey(data, "home") || matchesKey(data, "end"),
				run: (data) => {
					if (matchesKey(data, "home")) this.moveSelectionToBoundary("start");
					else this.moveSelectionToBoundary("end");
				},
			},
		];

		if (hasSelection) {
			actions.push(
				{
					id: "jump",
					keys: [{ kind: "binding", value: "tui.select.confirm", fallback: "enter" }],
					footerLabel: "jump",
					helpLabel: "jump to the selected note's source",
					section: "Actions",
					footerRow: 1,
					match: (data) => this.keybindings.matches(data, "tui.select.confirm"),
					run: () => this.jumpToSelectedNote(),
				},
				{
					id: "edit",
					keys: [{ kind: "raw", value: "e" }],
					footerLabel: "edit",
					helpLabel: "edit the selected note",
					section: "Actions",
					footerRow: 1,
					match: (data) => matchesKey(data, "e"),
					run: () => this.editSelectedNote(),
				},
				{
					id: "delete",
					keys: [{ kind: "raw", value: "x" }],
					footerLabel: "delete",
					helpLabel: "delete the selected note",
					section: "Actions",
					footerRow: 1,
					match: (data) => matchesKey(data, "x"),
					run: () => this.deleteSelectedNote(),
				},
				{
					id: "review",
					keys: [{ kind: "raw", value: "d" }],
					footerLabel: annotations.length === 1 ? "review note" : `review ${annotations.length}`,
					helpLabel:
						annotations.length === 1
							? "load the pending note into Pi's input editor for review"
							: `load all ${annotations.length} pending notes into Pi's input editor for review`,
					section: "Actions",
					footerRow: 2,
					sticky: true,
					match: (data) => matchesKey(data, "d"),
					run: () => this.reviewAllNotes(),
				},
			);
		}

		actions.push(
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
				id: "back",
				keys: closeKeys,
				footerLabel: `back to ${this.sourceView}`,
				helpLabel: `return to the ${this.sourceView} view`,
				section: "General",
				footerRow: 2,
				sticky: true,
				match: (data) => this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "q"),
				run: () => this.goBack(),
			},
		);

		return actions;
	}

	private annotations(): ViewerAnnotation[] {
		return this.annotationController.list();
	}

	private selectedAnnotation(): ViewerAnnotation | undefined {
		const annotations = this.annotations();
		if (annotations.length === 0) return undefined;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, annotations.length - 1));
		return annotations[this.selectedIndex];
	}

	private snapshotState(): NotesViewerState {
		return {
			selectedIndex: this.selectedIndex,
			sourceView: this.sourceView,
		};
	}

	private goBack(): void {
		if (this.closed) return;
		this.closed = true;
		this.done({ action: "back", state: this.snapshotState() });
	}

	private jumpToSelectedNote(): void {
		const annotation = this.selectedAnnotation();
		if (!annotation || this.closed) return;
		this.closed = true;
		this.done({ action: "jump", state: this.snapshotState(), target: annotation.target });
	}

	private reviewAllNotes(): void {
		if (this.annotations().length === 0 || this.closed) return;
		this.closed = true;
		this.done({ action: "draft", state: this.snapshotState() });
	}

	private editSelectedNote(): void {
		const annotation = this.selectedAnnotation();
		if (!annotation) return;
		this.annotationModal = createAnnotationModal(
			this.tui,
			this.keybindings,
			`Edit note · ${describeAnnotationTarget(annotation.target)}`,
			annotation.note,
			annotation.target,
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
				this.lastActionMessage = "note removed";
			} else {
				this.lastActionMessage = "empty note discarded";
			}
		} else {
			this.annotationController.upsert(modal.target, trimmed);
			this.lastActionMessage = existing ? "note updated" : "note added";
		}
		this.closeAnnotationModal();
		if (this.annotations().length === 0) {
			this.goBack();
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, this.annotations().length - 1);
		this.tui.requestRender();
	}

	private cancelAnnotationModal(): void {
		this.closeAnnotationModal();
	}

	private closeAnnotationModal(): void {
		this.annotationModal = undefined;
		this.tui.requestRender();
	}

	private deleteSelectedNote(): void {
		const annotation = this.selectedAnnotation();
		if (!annotation) return;
		this.annotationController.remove(annotation.target);
		const remaining = this.annotations().length;
		if (remaining === 0) {
			this.lastActionMessage = "all notes cleared";
			this.goBack();
			return;
		}
		this.selectedIndex = Math.min(this.selectedIndex, remaining - 1);
		this.lastActionMessage = remaining === 1 ? "1 pending note left" : `${remaining} pending notes left`;
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		const annotations = this.annotations();
		if (annotations.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(annotations.length - 1, this.selectedIndex + delta));
		this.ensureSelectionVisible(this.listHeight(this.bodyHeight()));
		this.tui.requestRender();
	}

	private moveSelectionToBoundary(boundary: "start" | "end"): void {
		const annotations = this.annotations();
		if (annotations.length === 0) return;
		this.selectedIndex = boundary === "start" ? 0 : annotations.length - 1;
		this.ensureSelectionVisible(this.listHeight(this.bodyHeight()));
		this.tui.requestRender();
	}

	private toggleHelp(next?: boolean): void {
		this.showHelp = next ?? !this.showHelp;
		this.tui.requestRender();
	}

	private pageStep(): number {
		return Math.max(1, Math.round(this.listHeight(this.bodyHeight()) * 0.8));
	}

	private visibleHostHeight(width = this.tui.terminal.columns): number {
		return getVisibleHostHeight(this.tui, this, width);
	}

	private bodyHeight(width = this.tui.terminal.columns): number {
		return Math.max(1, this.visibleHostHeight(width) - HEADER_LINES - FOOTER_LINES);
	}

	private detailHeight(bodyHeight: number): number {
		if (bodyHeight <= 8) return Math.max(3, bodyHeight - 3);
		return Math.min(10, Math.max(6, Math.floor(bodyHeight * 0.45)));
	}

	private listHeight(bodyHeight: number): number {
		return Math.max(1, bodyHeight - this.detailHeight(bodyHeight) - 1);
	}

	private ensureSelectionVisible(viewHeight: number): void {
		const annotations = this.annotations();
		if (annotations.length === 0) {
			this.scroll = 0;
			return;
		}
		if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
		else if (this.selectedIndex >= this.scroll + viewHeight) this.scroll = this.selectedIndex - viewHeight + 1;
		const maxScroll = Math.max(0, annotations.length - viewHeight);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		if (this.scroll < 0) this.scroll = 0;
	}

	private fillVertical(lines: string[], width: number, height: number, alreadyFitted = false): string[] {
		const output = lines.slice(0, height).map((line) => (alreadyFitted ? line : fitLine(line, width)));
		while (output.length < height) output.push(" ".repeat(width));
		return output;
	}
}
