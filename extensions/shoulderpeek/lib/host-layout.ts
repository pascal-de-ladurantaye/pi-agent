import type { Component, TUI } from "@mariozechner/pi-tui";

interface ComponentWithChildren {
	children?: Component[];
}

function childComponents(component: Component): Component[] {
	const maybeChildren = (component as ComponentWithChildren).children;
	return Array.isArray(maybeChildren) ? maybeChildren : [];
}

function containsComponent(root: Component, target: Component, seen = new Set<Component>()): boolean {
	if (root === target) return true;
	if (seen.has(root)) return false;
	seen.add(root);

	for (const child of childComponents(root)) {
		if (containsComponent(child, target, seen)) return true;
	}

	return false;
}

function safeRenderHeight(component: Component, width: number): number {
	try {
		return component.render(width).length;
	} catch {
		return 0;
	}
}

/**
 * Estimate how many terminal rows are actually visible to a custom editor component.
 *
 * Pi's viewport is bottom-anchored, so content rendered after the editor container
 * (widgets below, footer, etc.) is what steals visible space from the editor.
 */
export function getVisibleHostHeight(tui: TUI, target: Component, width = tui.terminal.columns): number {
	const terminalHeight = Math.max(1, tui.terminal.rows);
	const renderWidth = Math.max(1, width || tui.terminal.columns || 1);
	const hostIndex = tui.children.findIndex((child) => containsComponent(child, target));
	if (hostIndex < 0) return terminalHeight;

	let linesAfterHost = 0;
	for (const child of tui.children.slice(hostIndex + 1)) {
		linesAfterHost += safeRenderHeight(child, renderWidth);
	}

	return Math.max(1, terminalHeight - linesAfterHost);
}
