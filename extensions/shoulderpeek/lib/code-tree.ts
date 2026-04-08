import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { CodeDirNode, CodeTreeNode, CodeVisibleRow } from "../types";

const IGNORED_NAMES = new Set([".git", "node_modules", ".DS_Store"]);

interface GitIgnoreContext {
	repoRoot: string;
	rootPrefix: string;
}

function compareTreeNodes(a: CodeTreeNode, b: CodeTreeNode): number {
	if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
	return a.name.localeCompare(b.name);
}

function countDescendantFiles(children: CodeTreeNode[]): number {
	let total = 0;
	for (const child of children) {
		total += child.kind === "file" ? 1 : child.descendantFileCount;
	}
	return total;
}

function toGitPath(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

function splitNullTerminated(output: string): string[] {
	const chunks = output.split("\u0000");
	if (chunks.length > 0 && chunks[chunks.length - 1] === "") chunks.pop();
	return chunks.filter((chunk) => chunk.length > 0);
}

function runGitCommand(
	cwd: string,
	args: string[],
	input?: string,
	timeoutMs = 4_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			child.kill();
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});

		child.stdin.end(input);
	});
}

async function resolveGitIgnoreContext(rootPath: string): Promise<GitIgnoreContext | undefined> {
	try {
		const result = await runGitCommand(rootPath, ["rev-parse", "--show-toplevel"], undefined, 3_000);
		if (result.code !== 0) return undefined;
		const repoRoot = result.stdout.trim();
		if (!repoRoot) return undefined;
		const rootPrefix = toGitPath(path.relative(repoRoot, rootPath));
		if (rootPrefix === ".." || rootPrefix.startsWith("../")) return undefined;
		return {
			repoRoot,
			rootPrefix: rootPrefix === "." ? "" : rootPrefix,
		};
	} catch {
		return undefined;
	}
}

async function findIgnoredChildNames(
	gitIgnore: GitIgnoreContext | undefined,
	relativePath: string,
	dirents: Dirent[],
): Promise<Set<string>> {
	if (!gitIgnore) return new Set();

	const candidates = dirents
		.filter((dirent) => !IGNORED_NAMES.has(dirent.name))
		.map((dirent) => {
			const childRelativePath = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
			const repoRelativePath = gitIgnore.rootPrefix ? `${gitIgnore.rootPrefix}/${childRelativePath}` : childRelativePath;
			return {
				name: dirent.name,
				repoRelativePath,
				isDirectory: dirent.isDirectory(),
			};
		});
	if (candidates.length === 0) return new Set();

	try {
		const result = await runGitCommand(
			gitIgnore.repoRoot,
			["check-ignore", "-z", "--stdin"],
			`${candidates.map((candidate) => candidate.repoRelativePath).join("\u0000")}\u0000`,
			5_000,
		);
		if (result.code !== 0 && result.code !== 1) return new Set();

		const ignoredPaths = new Set(splitNullTerminated(result.stdout));
		const ignoredNames = new Set<string>();
		for (const candidate of candidates) {
			if (
				ignoredPaths.has(candidate.repoRelativePath) ||
				(candidate.isDirectory && ignoredPaths.has(`${candidate.repoRelativePath}/`))
			) {
				ignoredNames.add(candidate.name);
			}
		}
		return ignoredNames;
	} catch {
		return new Set();
	}
}

async function scanDirectory(
	rootPath: string,
	gitIgnore: GitIgnoreContext | undefined,
	relativePath = "",
	parentPath: string | null = null,
): Promise<CodeDirNode> {
	const absolutePath = relativePath ? path.join(rootPath, relativePath) : rootPath;
	const dirents = await readdir(absolutePath, { withFileTypes: true });
	const ignoredNames = await findIgnoredChildNames(gitIgnore, relativePath, dirents);
	const children: CodeTreeNode[] = [];

	for (const dirent of dirents) {
		if (IGNORED_NAMES.has(dirent.name) || ignoredNames.has(dirent.name)) continue;

		const childRelativePath = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;
		if (dirent.isDirectory()) {
			try {
				children.push(await scanDirectory(rootPath, gitIgnore, childRelativePath, relativePath || null));
			} catch {
				// Skip unreadable subdirectories.
			}
			continue;
		}

		children.push({
			kind: "file",
			name: dirent.name,
			path: childRelativePath,
			parentPath: relativePath || null,
		});
	}

	children.sort(compareTreeNodes);
	return {
		kind: "dir",
		name: relativePath ? path.basename(relativePath) : path.basename(rootPath),
		path: relativePath,
		parentPath,
		descendantFileCount: countDescendantFiles(children),
		children,
	};
}

export async function scanCodeTree(rootPath: string): Promise<CodeDirNode> {
	const gitIgnore = await resolveGitIgnoreContext(rootPath);
	return scanDirectory(rootPath, gitIgnore);
}

export function flattenCodeTree(node: CodeDirNode, collapsedDirs: Set<string>, depth = 0): CodeVisibleRow[] {
	const rows: CodeVisibleRow[] = [];

	for (const child of node.children) {
		rows.push({ node: child, depth });
		if (child.kind === "dir" && !collapsedDirs.has(child.path)) {
			rows.push(...flattenCodeTree(child, collapsedDirs, depth + 1));
		}
	}

	return rows;
}
