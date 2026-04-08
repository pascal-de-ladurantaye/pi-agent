import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { DiffViewerComponent } from "../components/diff-viewer";
import type { DiffViewerState, ViewerAnnotationController, ViewerResult } from "../types";

export async function openDiffViewer(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	options: {
		state?: DiffViewerState;
		annotationController: ViewerAnnotationController;
	},
): Promise<ViewerResult | undefined> {
	return ctx.ui.custom<ViewerResult | undefined>((tui, theme, keybindings, done) => {
		return new DiffViewerComponent(pi, repoRoot, tui, theme, keybindings, done, options);
	});
}
