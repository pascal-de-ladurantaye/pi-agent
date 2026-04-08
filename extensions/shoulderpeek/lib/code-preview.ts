import { readFile } from "node:fs/promises";
import path from "node:path";

import { getLanguageFromPath, highlightCode } from "@mariozechner/pi-coding-agent";

import { replaceTabs, splitAnsiLines } from "./render";

import type { CodeLoadedPreview } from "../types";

const MAX_CODE_PREVIEW_BYTES = 200_000;

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end -= 1;
	return lines.slice(0, end);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function loadCodePreview(rootPath: string, relativePath: string): Promise<CodeLoadedPreview> {
	const absolutePath = path.join(rootPath, relativePath);

	try {
		const buffer = await readFile(absolutePath);
		const metadataLines = [`size: ${formatBytes(buffer.length)}`];
		if (buffer.includes(0)) {
			return {
				type: "message",
				metadataLines,
				lines: ["Binary file preview is not supported."],
				plainLines: ["Binary file preview is not supported."],
			};
		}

		const truncated = buffer.length > MAX_CODE_PREVIEW_BYTES;
		const previewBuffer = truncated ? buffer.subarray(0, MAX_CODE_PREVIEW_BYTES) : buffer;
		const text = normalizeNewlines(previewBuffer.toString("utf8"));
		const displayText = replaceTabs(text);
		const lang = getLanguageFromPath(relativePath);
		if (lang) metadataLines.push(`language: ${lang}`);
		if (truncated) metadataLines.push(`preview truncated to ${formatBytes(MAX_CODE_PREVIEW_BYTES)}`);

		const plainLines = trimTrailingEmptyLines(displayText.split("\n"));
		const lines = trimTrailingEmptyLines(
			lang
				? highlightCode(displayText, lang).flatMap((line) => splitAnsiLines(replaceTabs(line)))
				: [...plainLines],
		);
		return {
			type: "text",
			metadataLines,
			lines: lines.length > 0 ? lines : [""],
			plainLines: plainLines.length > 0 ? plainLines : [""],
		};
	} catch (error) {
		const line = error instanceof Error ? error.message : String(error);
		return {
			type: "message",
			metadataLines: [],
			lines: [line],
			plainLines: [line],
		};
	}
}
