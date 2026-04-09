import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

import { fitLine, wrapAnsiLines } from "./render";

export interface ShortcutKeySpec {
	kind: "binding" | "raw";
	value: string;
	fallback?: string;
	allBindings?: boolean;
}

export interface ShortcutHintAction {
	id: string;
	keys: ShortcutKeySpec[];
	footerLabel: string;
	helpLabel?: string;
	section: string;
	footerRow: 1 | 2;
	sticky?: boolean;
}

function prettyKeyPart(part: string): string {
	switch (part) {
		case "up":
			return "↑";
		case "down":
			return "↓";
		case "left":
			return "←";
		case "right":
			return "→";
		case "pageUp":
			return "PgUp";
		case "pageDown":
			return "PgDn";
		case "escape":
		case "esc":
			return "Esc";
		case "enter":
		case "return":
			return "Enter";
		case "tab":
			return "Tab";
		case "space":
			return "Space";
		case "home":
			return "Home";
		case "end":
			return "End";
		case "backspace":
			return "Backspace";
		case "delete":
			return "Del";
		case "insert":
			return "Ins";
		case "ctrl":
			return "Ctrl";
		case "shift":
			return "Shift";
		case "alt":
			return "Alt";
		default:
			if (part.length === 1 && /[a-z]/.test(part)) return part.toUpperCase();
			return part;
	}
}

function prettyKey(key: string): string {
	return key
		.split("+")
		.filter((part) => part.length > 0)
		.map((part) => prettyKeyPart(part))
		.join("+");
}

function keyLabelForSpec(keybindings: KeybindingsManager, spec: ShortcutKeySpec): string {
	if (spec.kind === "raw") return prettyKey(spec.value);

	const boundKeys = keybindings.getKeys(spec.value as Parameters<KeybindingsManager["getKeys"]>[0]);
	if (boundKeys.length === 0) return spec.fallback ? prettyKey(spec.fallback) : prettyKey(spec.value);
	if (spec.allBindings) return boundKeys.map((key) => prettyKey(key)).join("/");
	return prettyKey(boundKeys[0]!);
}

export function shortcutKeysLabel(keybindings: KeybindingsManager, action: Pick<ShortcutHintAction, "keys">): string {
	return action.keys.map((key) => keyLabelForSpec(keybindings, key)).join("/");
}

export function renderShortcutHint(
	theme: Theme,
	keybindings: KeybindingsManager,
	action: ShortcutHintAction,
	mode: "footer" | "help" = "footer",
): string {
	const label = mode === "help" ? (action.helpLabel ?? action.footerLabel) : action.footerLabel;
	return theme.fg("accent", `[${shortcutKeysLabel(keybindings, action)}]`) + theme.fg(mode === "help" ? "text" : "muted", ` ${label}`);
}

function joinHints(parts: string[], separator: string): string {
	return parts.join(separator);
}

function packHintStrings(parts: string[], width: number, separator: string): string {
	if (width <= 0 || parts.length === 0) return "";
	const packed: string[] = [];
	let usedWidth = 0;
	for (const part of parts) {
		const partWidth = visibleWidth(part);
		const nextWidth = partWidth + (packed.length > 0 ? visibleWidth(separator) : 0);
		if (packed.length > 0 && usedWidth + nextWidth > width) break;
		if (packed.length === 0 && partWidth > width) {
			packed.push(part);
			break;
		}
		packed.push(part);
		usedWidth += nextWidth;
	}
	return joinHints(packed, separator);
}

export function renderShortcutFooterLine(
	theme: Theme,
	keybindings: KeybindingsManager,
	width: number,
	actions: ShortcutHintAction[],
): string {
	const separator = theme.fg("dim", "  ");
	const sticky = actions.filter((action) => action.sticky).map((action) => renderShortcutHint(theme, keybindings, action));
	const primary = actions.filter((action) => !action.sticky).map((action) => renderShortcutHint(theme, keybindings, action));

	const stickyText = packHintStrings(sticky, width, separator);
	let primaryWidthBudget = width;
	if (stickyText.length > 0) primaryWidthBudget -= visibleWidth(stickyText);
	if (stickyText.length > 0 && primary.length > 0) primaryWidthBudget -= visibleWidth(separator);
	const primaryText = packHintStrings(primary, Math.max(0, primaryWidthBudget), separator);

	const combined = primaryText && stickyText ? `${primaryText}${separator}${stickyText}` : primaryText || stickyText;
	return fitLine(combined, width);
}

export function renderShortcutHelp(
	theme: Theme,
	keybindings: KeybindingsManager,
	width: number,
	height: number,
	title: string,
	subtitle: string,
	actions: ShortcutHintAction[],
): string[] {
	if (width <= 0 || height <= 0) return [];

	const margin = width >= 72 ? 2 : 1;
	const panelWidth = Math.max(1, width - margin * 2);
	const innerWidth = Math.max(1, panelWidth - 4);
	const leftPad = " ".repeat(margin);
	const border = theme.fg("border", `┌${"─".repeat(Math.max(0, panelWidth - 2))}┐`);
	const bottomBorder = theme.fg("border", `└${"─".repeat(Math.max(0, panelWidth - 2))}┘`);

	const sectionOrder: string[] = [];
	const grouped = new Map<string, ShortcutHintAction[]>();
	for (const action of actions) {
		if (!grouped.has(action.section)) {
			grouped.set(action.section, []);
			sectionOrder.push(action.section);
		}
		grouped.get(action.section)!.push(action);
	}

	const contentLines: string[] = [];
	contentLines.push(theme.fg("accent", theme.bold(title)));
	contentLines.push(theme.fg("muted", subtitle));
	contentLines.push(theme.fg("dim", "Press ? or Esc to close help."));
	contentLines.push("");

	for (const section of sectionOrder) {
		contentLines.push(theme.fg("accent", theme.bold(section)));
		for (const action of grouped.get(section) ?? []) {
			contentLines.push(`  ${renderShortcutHint(theme, keybindings, action, "help")}`);
		}
		contentLines.push("");
	}
	while (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();

	const wrappedContent: string[] = [];
	for (const line of contentLines) {
		const wrapped = wrapAnsiLines([line], innerWidth);
		wrappedContent.push(...(wrapped.length > 0 ? wrapped : [""]));
	}

	const maxBodyLines = Math.max(1, height - 2);
	let clippedContent = wrappedContent.slice(0, maxBodyLines);
	if (wrappedContent.length > maxBodyLines && clippedContent.length > 0) {
		clippedContent[clippedContent.length - 1] = theme.fg("muted", "…");
	}

	const lines: string[] = [fitLine(`${leftPad}${border}`, width)];
	for (const line of clippedContent) {
		const body = `${theme.fg("border", "│")} ${fitLine(line, innerWidth)} ${theme.fg("border", "│")}`;
		lines.push(fitLine(`${leftPad}${body}`, width));
	}
	while (lines.length < height - 1) {
		const body = `${theme.fg("border", "│")} ${" ".repeat(innerWidth)} ${theme.fg("border", "│")}`;
		lines.push(fitLine(`${leftPad}${body}`, width));
	}
	lines.push(fitLine(`${leftPad}${bottomBorder}`, width));
	return lines.slice(0, height);
}
