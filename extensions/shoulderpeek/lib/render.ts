import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

import type { AggregateStats, ChangedFile } from "../types";

export function formatKeys(keys: string[]): string {
	if (keys.length === 0) return "";
	if (keys.length === 1) return keys[0]!;
	return keys.join("/");
}

export function fitLine(line: string, width: number): string {
	if (width <= 0) return "";
	const truncated = truncateToWidth(line, width);
	const padding = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(padding);
}

export function splitAnsiLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function wrapAnsiLines(lines: string[], width: number): string[] {
	if (width <= 0) return [];
	const wrapped: string[] = [];
	for (const line of lines) {
		const parts = wrapTextWithAnsi(line, width);
		if (parts.length === 0) wrapped.push("");
		else wrapped.push(...parts);
	}
	return wrapped;
}

function renderCountBadge(theme: Theme, label: string, color: "success" | "warning" | "accent" | "error" | "muted"): string {
	return theme.fg(color, `[${label}]`);
}

export function renderFileBadges(theme: Theme, entry: ChangedFile | AggregateStats): string {
	if ("fileCount" in entry) {
		const parts: string[] = [];
		if (entry.stagedCount > 0) parts.push(renderCountBadge(theme, `S:${entry.stagedCount}`, "success"));
		if (entry.unstagedCount > 0) parts.push(renderCountBadge(theme, `U:${entry.unstagedCount}`, "warning"));
		if (entry.untrackedCount > 0) parts.push(renderCountBadge(theme, `?:${entry.untrackedCount}`, "accent"));
		if (entry.renamedCount > 0) parts.push(renderCountBadge(theme, `R:${entry.renamedCount}`, "muted"));
		if (entry.conflictedCount > 0) parts.push(renderCountBadge(theme, `C:${entry.conflictedCount}`, "error"));
		return parts.length > 0 ? ` ${parts.join(" ")}` : "";
	}

	const parts: string[] = [];
	if (entry.staged) parts.push(renderCountBadge(theme, "S", "success"));
	if (entry.unstaged) parts.push(renderCountBadge(theme, entry.untracked ? "?" : "U", entry.untracked ? "accent" : "warning"));
	if (entry.renamed) parts.push(renderCountBadge(theme, "R", "muted"));
	if (entry.conflicted) parts.push(renderCountBadge(theme, "C", "error"));
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}
