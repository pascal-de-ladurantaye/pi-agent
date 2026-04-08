import type { AggregateStats, ChangedFile, DirNode, FileFilter, TreeNode, VisibleTreeRow } from "../types";

export function emptyStats(): AggregateStats {
	return {
		fileCount: 0,
		stagedCount: 0,
		unstagedCount: 0,
		untrackedCount: 0,
		conflictedCount: 0,
		renamedCount: 0,
	};
}

export function accumulateStats(target: AggregateStats, source: AggregateStats): AggregateStats {
	target.fileCount += source.fileCount;
	target.stagedCount += source.stagedCount;
	target.unstagedCount += source.unstagedCount;
	target.untrackedCount += source.untrackedCount;
	target.conflictedCount += source.conflictedCount;
	target.renamedCount += source.renamedCount;
	return target;
}

export function isRenameCode(code: string): boolean {
	return code === "R" || code === "C";
}

export function isConflictStatus(status: string): boolean {
	return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
}

export function matchesFilter(entry: ChangedFile, filter: FileFilter): boolean {
	switch (filter) {
		case "staged":
			return entry.staged;
		case "unstaged":
			return entry.unstaged;
		default:
			return entry.staged || entry.unstaged;
	}
}

export function parseStatusPorcelainV1Z(output: string): ChangedFile[] {
	const entries: ChangedFile[] = [];
	const chunks = output.split("\u0000");

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const status = chunk.slice(0, 2);
		if (status === "!!") continue;
		const filePath = chunk.slice(3);
		if (!filePath) continue;

		let origPath: string | undefined;
		if (isRenameCode(status[0] ?? "") || isRenameCode(status[1] ?? "")) {
			origPath = chunks[i + 1] || undefined;
			i += 1;
		}

		const conflicted = isConflictStatus(status);
		const untracked = status === "??";
		const x = status[0] ?? "?";
		const y = status[1] ?? "?";

		entries.push({
			path: filePath,
			origPath,
			x,
			y,
			staged: !untracked && x !== " ",
			unstaged: untracked || y !== " ",
			untracked,
			conflicted,
			renamed: Boolean(origPath),
			copied: x === "C" || y === "C",
			added: x === "A" || (!untracked && y === "A"),
			deleted: x === "D" || y === "D",
		});
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));
	return entries;
}

function sortTree(node: DirNode): void {
	node.children.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	for (const child of node.children) {
		if (child.kind === "dir") sortTree(child);
	}
}

function computeAggregate(node: TreeNode): AggregateStats {
	if (node.kind === "file") {
		const stats = emptyStats();
		stats.fileCount = 1;
		if (node.entry.staged) stats.stagedCount = 1;
		if (node.entry.unstaged) stats.unstagedCount = 1;
		if (node.entry.untracked) stats.untrackedCount = 1;
		if (node.entry.conflicted) stats.conflictedCount = 1;
		if (node.entry.renamed) stats.renamedCount = 1;
		node.aggregate = stats;
		return stats;
	}

	const aggregate = emptyStats();
	for (const child of node.children) {
		accumulateStats(aggregate, computeAggregate(child));
	}
	node.aggregate = aggregate;
	return aggregate;
}

export function buildTree(entries: ChangedFile[]): DirNode {
	const root: DirNode = {
		kind: "dir",
		name: "",
		path: "",
		parentPath: null,
		aggregate: emptyStats(),
		children: [],
	};

	for (const entry of entries) {
		const parts = entry.path.split("/");
		let current = root;
		let currentPath = "";

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			const isLast = i === parts.length - 1;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (isLast) {
				current.children.push({
					kind: "file",
					name: part,
					path: currentPath,
					parentPath: current.path || null,
					aggregate: emptyStats(),
					entry,
				});
				continue;
			}

			let next = current.children.find(
				(child): child is DirNode => child.kind === "dir" && child.path === currentPath,
			);
			if (!next) {
				next = {
					kind: "dir",
					name: part,
					path: currentPath,
					parentPath: current.path || null,
					aggregate: emptyStats(),
					children: [],
				};
				current.children.push(next);
			}
			current = next;
		}
	}

	sortTree(root);
	computeAggregate(root);
	return root;
}

export function flattenTree(node: DirNode, collapsedDirs: Set<string>, depth = 0): VisibleTreeRow[] {
	const rows: VisibleTreeRow[] = [];

	for (const child of node.children) {
		rows.push({ node: child, depth });
		if (child.kind === "dir" && !collapsedDirs.has(child.path)) {
			rows.push(...flattenTree(child, collapsedDirs, depth + 1));
		}
	}

	return rows;
}
