import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { NotesViewerComponent } from "../components/notes-viewer";
import type { NotesViewerResult, NotesViewerState, ViewerAnnotationController, ViewerView } from "../types";

export async function openNotesViewer(
	ctx: ExtensionCommandContext,
	options: {
		state?: NotesViewerState;
		sourceView: ViewerView;
		annotationController: ViewerAnnotationController;
	},
): Promise<NotesViewerResult> {
	return ctx.ui.custom<NotesViewerResult>((tui, theme, keybindings, done) => {
		return new NotesViewerComponent(options.sourceView, options.annotationController, tui, theme, keybindings, done, options);
	});
}
