import { ExtensionEditorComponent, type KeybindingsManager } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";

import { fitLine } from "../lib/render";

export interface AnnotationModalState<TTarget> {
	target: TTarget;
	editor: ExtensionEditorComponent;
}

export function createAnnotationModal<TTarget>(
	tui: TUI,
	keybindings: KeybindingsManager,
	title: string,
	prefill: string | undefined,
	target: TTarget,
	onSubmit: (value: string) => void,
	onCancel: () => void,
): AnnotationModalState<TTarget> {
	return {
		target,
		editor: new ExtensionEditorComponent(tui, keybindings, title, prefill, onSubmit, onCancel),
	};
}

export function computeAnnotationModalWidth(paneWidth: number): number {
	return Math.max(1, paneWidth);
}

export function overlayAnnotationModal(baseLines: string[], paneWidth: number, modalLines: string[]): string[] {
	if (baseLines.length === 0 || paneWidth <= 0 || modalLines.length === 0) return baseLines;

	const modalWidth = computeAnnotationModalWidth(paneWidth);
	const clippedLines = modalLines.slice(0, baseLines.length);
	const topPad = Math.max(0, baseLines.length - clippedLines.length);
	const output = [...baseLines];

	for (let i = 0; i < clippedLines.length; i++) {
		output[topPad + i] = fitLine(clippedLines[i]!, modalWidth);
	}

	return output;
}
