import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { buildAnnotationDraft, findAnnotationByTarget, removeAnnotation, upsertAnnotation } from "./lib/annotations";
import { resolveRepoRoot } from "./lib/git";
import type {
	CodeViewerState,
	DiffViewerState,
	NotesViewerState,
	ViewerAnnotation,
	ViewerAnnotationController,
	ViewerAnnotationTarget,
	ViewerResult,
	ViewerState,
	ViewerView,
} from "./types";
import { openCodeViewer } from "./views/code";
import { openDiffViewer } from "./views/diff";
import { openNotesViewer } from "./views/notes";

function rememberViewerState(
	state: ViewerState,
	current: { codeState?: CodeViewerState; diffState?: DiffViewerState },
): void {
	if (state.view === "code") current.codeState = state;
	else current.diffState = state;
}

function expandedCollapsedDirs(collapsedDirs: string[], targetPath: string): string[] {
	const ancestors = new Set<string>();
	const parts = targetPath.split("/");
	let current = "";
	for (let i = 0; i < parts.length - 1; i++) {
		current = current ? `${current}/${parts[i]!}` : parts[i]!;
		ancestors.add(current);
	}
	return collapsedDirs.filter((path) => !ancestors.has(path));
}

function applyAnnotationJump(
	target: ViewerAnnotationTarget,
	state: { codeState?: CodeViewerState; diffState?: DiffViewerState },
): ViewerView {
	if (target.view === "code") {
		const current = state.codeState;
		state.codeState = {
			view: "code",
			selectedPath: target.path,
			collapsedDirs: expandedCollapsedDirs(current?.collapsedDirs ?? [], target.path),
			treePaneVisible: current?.treePaneVisible ?? true,
			activePane: "content",
			selectedLineIndex: Math.max(0, target.endLine - 1),
			selectionAnchorLineIndex: target.startLine === target.endLine ? undefined : Math.max(0, target.startLine - 1),
		};
		return "code";
	}

	const current = state.diffState;
	state.diffState = {
		view: "diff",
		selectedPath: target.path,
		collapsedDirs: expandedCollapsedDirs(current?.collapsedDirs ?? [], target.path),
		treePaneVisible: current?.treePaneVisible ?? true,
		activePane: "content",
		selectedLineIndex: 0,
		selectionAnchorLineIndex: undefined,
		filter: "all",
		diffScopePreference: target.scope,
		focusRef: target.refs[0],
	};
	return "diff";
}

async function placeDraftInEditor(ctx: ExtensionCommandContext, draft: string): Promise<boolean> {
	const existing = ctx.ui.getEditorText();
	if (existing.trim()) {
		const choice = await ctx.ui.select("Shoulderpeek notes", ["Replace editor text", "Append below existing editor text", "Cancel"]);
		if (!choice || choice === "Cancel") return false;
		if (choice === "Append below existing editor text") {
			const prefix = existing.trimEnd();
			ctx.ui.setEditorText(prefix.length > 0 ? `${prefix}\n\n${draft}` : draft);
		} else {
			ctx.ui.setEditorText(draft);
		}
	} else {
		ctx.ui.setEditorText(draft);
	}

	ctx.ui.notify("Pending notes loaded into the input editor. Review, edit, and send when ready.", "info");
	return true;
}

async function openViewerSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, initialView: ViewerView): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("shoulderpeek requires interactive mode", "error");
		return;
	}

	let currentView: ViewerView | "notes" = initialView;
	let annotations: ViewerAnnotation[] = [];
	let notesState: NotesViewerState = { selectedIndex: 0, sourceView: initialView };
	const state: { codeState?: CodeViewerState; diffState?: DiffViewerState } = {};
	const annotationController: ViewerAnnotationController = {
		list: () => annotations,
		find: (target) => findAnnotationByTarget(annotations, target),
		upsert: (target, note) => {
			annotations = upsertAnnotation(annotations, target, note);
		},
		remove: (target) => {
			annotations = removeAnnotation(annotations, target);
		},
	};

	while (true) {
		if (currentView === "notes") {
			const result = await openNotesViewer(ctx, { state: notesState, sourceView: notesState.sourceView, annotationController });
			if (!result) {
				currentView = notesState.sourceView;
				continue;
			}

			notesState = result.state;
			if (result.action === "back") {
				currentView = result.state.sourceView;
				continue;
			}

			if (result.action === "jump") {
				currentView = applyAnnotationJump(result.target, state);
				continue;
			}

			if (annotations.length === 0) {
				ctx.ui.notify("No annotations to review yet", "warning");
				currentView = result.state.sourceView;
				continue;
			}

			const draft = buildAnnotationDraft(ctx.cwd, annotations);
			const placed = await placeDraftInEditor(ctx, draft);
			if (!placed) {
				currentView = "notes";
				continue;
			}
			return;
		}

		let result: ViewerResult | undefined;
		if (currentView === "diff") {
			const repoRoot = await resolveRepoRoot(pi, ctx.cwd);
			if (!repoRoot) {
				ctx.ui.notify("shoulderpeek diff requires a git repository", "error");
				if (initialView === "diff") return;
				currentView = "code";
				continue;
			}

			result = await openDiffViewer(pi, ctx, repoRoot, { state: state.diffState, annotationController });
		} else {
			result = await openCodeViewer(ctx, { state: state.codeState, annotationController });
		}

		if (!result) return;
		rememberViewerState(result.state, state);

		if (result.action === "switch") {
			currentView = result.view;
			continue;
		}

		if (result.action === "notes") {
			notesState = { ...notesState, sourceView: result.state.view };
			currentView = "notes";
			continue;
		}

		if (annotations.length === 0) {
			ctx.ui.notify("No annotations to review yet", "warning");
			currentView = result.state.view;
			continue;
		}

		const draft = buildAnnotationDraft(ctx.cwd, annotations);
		const placed = await placeDraftInEditor(ctx, draft);
		if (!placed) {
			currentView = result.state.view;
			continue;
		}
		return;
	}
}

export default function shoulderpeekExtension(pi: ExtensionAPI): void {
	const getArgumentCompletions = (prefix: string) => {
		const items = [
			{ value: "diff", label: "diff" },
			{ value: "code", label: "code" },
		];
		const filtered = items.filter((item) => item.value.startsWith(prefix));
		return filtered.length > 0 ? filtered : null;
	};

	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		const trimmed = args.trim();
		const view = (trimmed === "" ? "diff" : trimmed.split(/\s+/, 1)[0]!) as ViewerView | string;
		if (view === "diff" || view === "code") {
			await openViewerSession(pi, ctx, view);
			return;
		}
		ctx.ui.notify(`Unknown shoulderpeek view: ${view}. Available: diff, code`, "error");
	};

	pi.registerCommand("shoulderpeek", {
		description: "Inspect the agent's work, annotate it, and aggregate notes into a follow-up prompt",
		getArgumentCompletions,
		handler,
	});
}
