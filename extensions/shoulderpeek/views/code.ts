import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { CodeViewerComponent } from "../components/code-viewer";
import type { CodeViewerState, ViewerAnnotationController, ViewerResult } from "../types";

export async function openCodeViewer(
	ctx: ExtensionCommandContext,
	options: {
		state?: CodeViewerState;
		annotationController: ViewerAnnotationController;
	},
): Promise<ViewerResult | undefined> {
	return ctx.ui.custom<ViewerResult | undefined>((tui, theme, keybindings, done) => {
		return new CodeViewerComponent(ctx.cwd, tui, theme, keybindings, done, options);
	});
}
