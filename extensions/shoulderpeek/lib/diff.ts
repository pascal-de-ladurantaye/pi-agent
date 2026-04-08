import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { diffLines as libDiffLines } from "diff";

import { DELTA_ARGS_BASE, MIN_DIFF_WIDTH } from "../constants";
import type { ChangedFile, DiffAnnotationSide, DiffScope, FileVersion, LoadedDiff } from "../types";
import { buildGitPatch, diffMetadataLines, oldPathForScope, readGitObject, readWorktreeFile } from "./git";

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface ParsedPiDiffLine {
	kind: "diff" | "elision";
	raw: string;
	text: string;
	ref?: string;
	side?: DiffAnnotationSide;
	lineNumber?: number;
}

function refForDiffLine(side: Exclude<DiffAnnotationSide, "mixed">, lineNumber: number): string {
	return `${side}:${lineNumber}`;
}

export function parsePiDiffLines(diffText: string): ParsedPiDiffLine[] {
	const lines = diffText.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

	return lines.map((line) => {
		const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
		if (!match) return { kind: "elision", raw: line, text: line };

		const [, prefix, rawLineNumber, text] = match;
		const trimmedLineNumber = rawLineNumber.trim();
		if (text === "..." || trimmedLineNumber === "") {
			return { kind: "elision", raw: line, text };
		}

		const lineNumber = Number.parseInt(trimmedLineNumber, 10);
		if (!Number.isFinite(lineNumber)) return { kind: "elision", raw: line, text };

		const side: Exclude<DiffAnnotationSide, "mixed"> = prefix === "+" ? "new" : prefix === "-" ? "old" : "context";
		return {
			kind: "diff",
			raw: line,
			text,
			lineNumber,
			side,
			ref: refForDiffLine(side, lineNumber),
		};
	});
}

export function generatePiDiffString(oldContent: string, newContent: string, contextLines = 3): string {
	const changes = libDiffLines(oldContent, newContent);
	const maxLen = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
	const lineNumWidth = String(maxLen).length;

	interface DiffEntry {
		type: "same" | "add" | "remove";
		text: string;
		oldLineNum: number;
		newLineNum: number;
	}

	const entries: DiffEntry[] = [];
	let oldLine = 1;
	let newLine = 1;

	for (const change of changes) {
		if (!change.value) continue;
		const lines = change.value.split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		if (lines.length === 0) continue;

		for (const text of lines) {
			if (change.removed) {
				entries.push({ type: "remove", text, oldLineNum: oldLine, newLineNum: newLine });
				oldLine += 1;
			} else if (change.added) {
				entries.push({ type: "add", text, oldLineNum: oldLine, newLineNum: newLine });
				newLine += 1;
			} else {
				entries.push({ type: "same", text, oldLineNum: oldLine, newLineNum: newLine });
				oldLine += 1;
				newLine += 1;
			}
		}
	}

	const isChange = entries.map((entry) => entry.type !== "same");
	const inContext = new Array(entries.length).fill(false);
	for (let i = 0; i < entries.length; i++) {
		if (!isChange[i]) continue;
		for (let j = Math.max(0, i - contextLines); j <= Math.min(entries.length - 1, i + contextLines); j++) {
			inContext[j] = true;
		}
	}

	const output: string[] = [];
	let previousShown = false;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (!inContext[i]) {
			previousShown = false;
			continue;
		}

		if (!previousShown && i > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
		previousShown = true;

		if (entry.type === "remove") {
			output.push(`-${String(entry.oldLineNum).padStart(lineNumWidth, " ")} ${entry.text}`);
		} else if (entry.type === "add") {
			output.push(`+${String(entry.newLineNum).padStart(lineNumWidth, " ")} ${entry.text}`);
		} else {
			output.push(` ${String(entry.oldLineNum).padStart(lineNumWidth, " ")} ${entry.text}`);
		}
	}

	return output.join("\n");
}

function runDelta(patch: string, width: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("delta", [...DELTA_ARGS_BASE, `--width=${Math.max(width, MIN_DIFF_WIDTH)}`], {
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout);
			else reject(new Error(stderr.trim() || `delta exited with code ${code ?? -1}`));
		});
		child.stdin.end(patch);
	});
}

export async function loadDeltaDiff(
	pi: ExtensionAPI,
	repoRoot: string,
	entry: ChangedFile,
	scope: DiffScope,
	paneWidth: number,
): Promise<LoadedDiff> {
	const metadataLines = diffMetadataLines(entry, scope);
	const patch = await buildGitPatch(pi, repoRoot, entry, scope);
	if (!patch.trim()) {
		return {
			type: "message",
			metadataLines,
			lines: ["No textual changes for this diff."],
		};
	}

	const output = await runDelta(patch, paneWidth);
	return {
		type: "delta",
		metadataLines,
		output,
	};
}

export async function loadPiDiff(
	pi: ExtensionAPI,
	repoRoot: string,
	entry: ChangedFile,
	scope: DiffScope,
	extraMetadata?: string,
): Promise<LoadedDiff> {
	const metadataLines = diffMetadataLines(entry, scope, extraMetadata);
	if (entry.conflicted) {
		return {
			type: "message",
			metadataLines,
			lines: [
				"Conflict previews are not implemented yet.",
				"Use git diff or resolve the conflict to inspect a clean inline patch.",
			],
		};
	}

	const oldPath = oldPathForScope(entry, scope);
	let oldVersion: FileVersion;
	let newVersion: FileVersion;

	if (scope === "staged") {
		oldVersion = await readGitObject(pi, repoRoot, `HEAD:${oldPath}`);
		newVersion = await readGitObject(pi, repoRoot, `:${entry.path}`);
	} else {
		oldVersion = entry.untracked ? { missing: true, binary: false, text: "" } : await readGitObject(pi, repoRoot, `:${oldPath}`);
		newVersion = await readWorktreeFile(repoRoot, entry.path);
	}

	if (oldVersion.binary || newVersion.binary) {
		return {
			type: "message",
			metadataLines,
			lines: [
				"Binary changes cannot be rendered with Pi's inline fallback.",
				"Use delta if available, or inspect the file with git diff directly.",
			],
		};
	}

	const oldText = normalizeNewlines(oldVersion.missing ? "" : oldVersion.text);
	const newText = normalizeNewlines(newVersion.missing ? "" : newVersion.text);
	const diffText = generatePiDiffString(oldText, newText);
	if (!diffText.trim()) {
		return {
			type: "message",
			metadataLines,
			lines: ["No textual changes for this diff."],
		};
	}

	return {
		type: "pi",
		metadataLines,
		diffText,
	};
}
