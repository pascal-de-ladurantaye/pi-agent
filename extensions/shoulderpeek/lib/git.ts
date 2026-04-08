import { promises as fs } from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { NULL_DEVICE } from "../constants";
import type { ChangedFile, DiffScope, FileVersion } from "../types";
import { isRenameCode } from "./tree";

function isProbablyBinary(text: string): boolean {
	return text.includes("\u0000");
}

export async function detectDelta(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("delta", ["--version"], { cwd, timeout: 2_000 });
	return result.code === 0;
}

export async function resolveRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3_000 });
	if (result.code !== 0) return undefined;
	const repoRoot = result.stdout.trim();
	return repoRoot || undefined;
}

export async function resolveBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: repoRoot,
		timeout: 3_000,
	});
	if (result.code !== 0) return undefined;
	const branch = result.stdout.trim();
	return branch || undefined;
}

export async function runGitDiff(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: repoRoot, timeout: 10_000 });
	if (result.code !== 0 && result.code !== 1) {
		throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.code}`);
	}
	return result.stdout;
}

export async function readGitObject(pi: ExtensionAPI, repoRoot: string, spec: string): Promise<FileVersion> {
	const result = await pi.exec("git", ["show", spec], { cwd: repoRoot, timeout: 10_000 });
	if (result.code !== 0) {
		return { missing: true, binary: false, text: "" };
	}

	const text = result.stdout;
	return {
		missing: false,
		binary: isProbablyBinary(text),
		text,
	};
}

export async function readWorktreeFile(repoRoot: string, relativePath: string): Promise<FileVersion> {
	const absolutePath = path.join(repoRoot, relativePath);
	try {
		const buffer = await fs.readFile(absolutePath);
		return {
			missing: false,
			binary: buffer.includes(0),
			text: buffer.toString("utf8"),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { missing: true, binary: false, text: "" };
		throw error;
	}
}

export function oldPathForScope(entry: ChangedFile, scope: DiffScope): string {
	if (scope === "staged" && entry.origPath && isRenameCode(entry.x)) return entry.origPath;
	if (scope === "unstaged" && entry.origPath && isRenameCode(entry.y)) return entry.origPath;
	return entry.path;
}

export function diffMetadataLines(entry: ChangedFile, scope: DiffScope, extra?: string): string[] {
	const lines: string[] = [];
	if (entry.renamed && entry.origPath) lines.push(`rename: ${entry.origPath} → ${entry.path}`);
	if (entry.untracked) lines.push("untracked file");
	if (entry.conflicted) lines.push(`conflict: status ${entry.x}${entry.y}`);
	if (scope === "staged" && entry.staged && entry.unstaged) lines.push("showing staged diff (HEAD → index)");
	if (scope === "unstaged" && entry.staged && entry.unstaged) lines.push("showing unstaged diff (index → worktree)");
	if (extra) lines.push(extra);
	return lines;
}

export async function buildGitPatch(
	pi: ExtensionAPI,
	repoRoot: string,
	entry: ChangedFile,
	scope: DiffScope,
): Promise<string> {
	if (scope === "unstaged" && entry.untracked) {
		return runGitDiff(pi, repoRoot, [
			"diff",
			"--no-index",
			"--no-color",
			"--no-ext-diff",
			"--",
			NULL_DEVICE,
			entry.path,
		]);
	}

	const args = [
		"diff",
		...(scope === "staged" ? ["--cached"] : []),
		"--no-color",
		"--no-ext-diff",
		"--find-renames",
		"--",
		entry.path,
	] as string[];

	if (entry.origPath && isRenameCode(scope === "staged" ? entry.x : entry.y)) {
		args.push(entry.origPath);
	}

	return runGitDiff(pi, repoRoot, args);
}
