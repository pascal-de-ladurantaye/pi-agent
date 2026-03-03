/**
 * Core library: convert a pi session JSONL file into markdown files.
 *
 * No pi imports — pure Node.js so backfill scripts can use it standalone.
 * Idempotent: hashes content per segment, skips unchanged files.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import type {
	Entry,
	SessionEntry,
	SessionInfoEntry,
	MessageEntry,
	ContentPart,
	Segment,
	SegmentMeta,
	ConvertResult,
	SessionMemoryConfig,
} from "./types";

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a single session JSONL file to markdown.
 * Writes segment files, session index, and canvas (if forks) to:
 *   config.vaultPath/raw/<session-dir>/
 */
export function convertSession(jsonlPath: string, config: SessionMemoryConfig): ConvertResult {
	const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
	const entries: Entry[] = lines.map((line) => JSON.parse(line));

	const session = entries[0] as SessionEntry;
	if (session.type !== "session") {
		throw new Error(`Expected session header as first line, got: ${session.type}`);
	}

	const sessionName = findSessionName(entries);
	const outputDirName = buildOutputDirName(jsonlPath, session);
	const outputDir = join(config.vaultPath, "raw", outputDirName);
	const isNewSession = !existsSync(join(outputDir, "_index.md"));
	mkdirSync(outputDir, { recursive: true });

	const segments = buildSegments(entries);
	const hasForks = segments.length > 1;

	let written = 0;
	let skipped = 0;

	for (const segment of segments) {
		const md = renderSegment(segment, session, sessionName);
		const hash = contentHash(md);
		const filePath = join(outputDir, `${segment.name}.md`);

		if (existsSync(filePath)) {
			const existing = readFileSync(filePath, "utf-8");
			const existingHash = extractFrontmatterField(existing, "content_hash");
			if (existingHash === hash) {
				skipped++;
				continue;
			}
		}

		const finalMd = md.replace("content_hash: PENDING", `content_hash: ${hash}`);
		writeFileSync(filePath, finalMd);
		written++;
	}

	// Always check index (session name can change independently of segment content)
	writeIfChanged(join(outputDir, "_index.md"), buildSessionIndex(outputDir, segments, session, sessionName));

	if (written > 0 && hasForks) {
		writeIfChanged(join(outputDir, "_tree.canvas"), buildSessionCanvas(segments));
	}

	return { sessionDir: outputDirName, written, skipped, total: segments.length, hasForks, isNewSession };
}

/**
 * Generate the top-level sessions MOC at config.vaultPath/_sessions.md.
 * Scans raw/ for session directories and groups by project.
 */
export function generateMOC(config: SessionMemoryConfig): void {
	const rawDir = join(config.vaultPath, "raw");
	if (!existsSync(rawDir)) return;

	const sessions: { dirname: string; date: string; project: string; uuid: string; sessionName: string | null }[] = [];

	for (const dirname of readdirSync(rawDir).sort()) {
		// Parse dirname: 2026-02-25-7a17aa7d-knowl-edge
		const match = dirname.match(/^(\d{4}-\d{2}-\d{2})-([a-f0-9]+)-(.+)$/);
		if (!match) continue;
		// Try to read session name from _index.md frontmatter
		const indexPath = join(rawDir, dirname, "_index.md");
		let sessionName: string | null = null;
		if (existsSync(indexPath)) {
			const content = readFileSync(indexPath, "utf-8");
			sessionName = extractFrontmatterField(content, "session_name");
		}
		sessions.push({ dirname, date: match[1], uuid: match[2], project: match[3], sessionName });
	}

	if (sessions.length === 0) return;

	// Group by project
	const byProject = new Map<string, typeof sessions>();
	for (const s of sessions) {
		let group = byProject.get(s.project);
		if (!group) {
			group = [];
			byProject.set(s.project, group);
		}
		group.push(s);
	}

	const lines = [
		"---",
		"tags: [session-moc]",
		"---",
		"",
		"# Sessions",
		"",
	];

	for (const [project, group] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		lines.push(`## ${project}`, "");
		for (const s of group) {
			const label = s.sessionName ? `${s.sessionName}` : s.dirname;
			lines.push(`- ${s.date} — [[${s.dirname}/_index|${label}]]`);
		}
		lines.push("");
	}

	writeIfChanged(join(config.vaultPath, "_sessions.md"), lines.join("\n"));
}

/** Find the latest session name from session_info entries. */
function findSessionName(entries: Entry[]): string | null {
	let name: string | null = null;
	for (const entry of entries) {
		if (entry.type === "session_info" && (entry as SessionInfoEntry).name) {
			name = (entry as SessionInfoEntry).name!;
		}
	}
	return name;
}

// ── Output directory naming ──────────────────────────────────────────────────

function buildOutputDirName(jsonlPath: string, session: SessionEntry): string {
	const filename = basename(jsonlPath, ".jsonl");
	const [datePart, uuid] = filename.split("_");
	const date = datePart.slice(0, 10);
	const shortUuid = uuid?.split("-")[0] ?? "unknown";
	const projectLeaf = session.cwd.split("/").filter(Boolean).pop() ?? "unknown";
	return `${date}-${shortUuid}-${projectLeaf}`;
}

// ── Tree segmentation ────────────────────────────────────────────────────────

function buildSegments(entries: Entry[]): Segment[] {
	const byId = new Map<string, Entry>();
	const childrenOf = new Map<string, string[]>();

	for (const entry of entries) {
		if (!entry.id) continue;
		byId.set(entry.id, entry);
		if (entry.parentId) {
			let kids = childrenOf.get(entry.parentId);
			if (!kids) {
				kids = [];
				childrenOf.set(entry.parentId, kids);
			}
			kids.push(entry.id);
		}
	}

	const root =
		entries.find((e) => e.id && !e.parentId && childrenOf.has(e.id)) ??
		entries.find((e) => e.id && !e.parentId && e.type !== "session");
	if (!root) return [];

	const activePathIds = buildActivePath(entries, byId);
	const segments: Segment[] = [];
	let forkCounter = 0;

	function walkChain(startId: string, parentSegmentName: string | null): void {
		const { chain, forkChildren } = collectChain(startId, byId, childrenOf);
		if (chain.length === 0) return;

		forkCounter++;
		const name = pad(forkCounter);
		const status = segmentStatus(chain, forkChildren, activePathIds);
		segments.push({ name, parentName: parentSegmentName, entries: chain, status });

		if (forkChildren.length > 1) {
			forkCounter++;
			const forkNum = pad(forkCounter);
			const letters = "abcdefghijklmnopqrstuvwxyz";
			for (let i = 0; i < forkChildren.length; i++) {
				walkBranch(forkChildren[i], name, forkNum, letters[i]);
			}
		}
	}

	function walkBranch(startId: string, parentName: string, forkNum: string, letter: string): void {
		const { chain, forkChildren } = collectChain(startId, byId, childrenOf);
		if (chain.length === 0) return;

		const name = `${forkNum}${letter}`;
		const status = segmentStatus(chain, forkChildren, activePathIds);
		segments.push({ name, parentName, entries: chain, status });

		if (forkChildren.length > 1) {
			forkCounter++;
			const nextForkNum = pad(forkCounter);
			const letters = "abcdefghijklmnopqrstuvwxyz";
			for (let i = 0; i < forkChildren.length; i++) {
				walkBranch(forkChildren[i], name, nextForkNum, letters[i]);
			}
		}
	}

	walkChain(root.id, null);
	return segments;
}

function collectChain(
	startId: string,
	byId: Map<string, Entry>,
	childrenOf: Map<string, string[]>,
): { chain: Entry[]; forkChildren: string[] } {
	const chain: Entry[] = [];
	let currentId: string | null = startId;

	while (currentId) {
		const entry = byId.get(currentId);
		if (!entry) break;
		chain.push(entry);

		const kids = childrenOf.get(currentId) ?? [];
		if (kids.length === 0) {
			return { chain, forkChildren: [] };
		} else if (kids.length === 1) {
			currentId = kids[0];
		} else {
			return { chain, forkChildren: kids };
		}
	}

	return { chain, forkChildren: [] };
}

function buildActivePath(entries: Entry[], byId: Map<string, Entry>): Set<string> {
	const path = new Set<string>();
	const lastEntry = entries[entries.length - 1];
	if (!lastEntry?.id) return path;

	let current: string | null = lastEntry.id;
	while (current) {
		path.add(current);
		const entry = byId.get(current);
		current = entry?.parentId ?? null;
	}
	return path;
}

function segmentStatus(
	chain: Entry[],
	forkChildren: string[],
	activePath: Set<string>,
): "active" | "abandoned" {
	for (const entry of chain) {
		if (activePath.has(entry.id)) return "active";
	}
	for (const childId of forkChildren) {
		if (activePath.has(childId)) return "active";
	}
	return "abandoned";
}

// ── Segment metadata ─────────────────────────────────────────────────────────

function computeSegmentMeta(segment: Segment): SegmentMeta {
	let messageCount = 0;
	const toolsUsed = new Set<string>();

	for (const entry of segment.entries) {
		if (entry.type !== "message") continue;
		const msg = (entry as MessageEntry).message;

		if (msg.role === "user" || msg.role === "assistant") messageCount++;

		if (msg.role === "assistant") {
			for (const c of msg.content ?? []) {
				if (c.type === "toolCall" && c.name) toolsUsed.add(c.name);
			}
		}
	}

	return { messageCount, toolsUsed: [...toolsUsed].sort() };
}

// ── Markdown rendering ───────────────────────────────────────────────────────

function renderSegment(segment: Segment, session: SessionEntry, sessionName: string | null): string {
	const meta = computeSegmentMeta(segment);
	const date = session.timestamp?.slice(0, 10) ?? "";
	const project = session.cwd.split("/").filter(Boolean).pop() ?? "";
	const title = sessionName ?? project;

	const frontmatter = [
		"---",
		`session_id: ${session.id}`,
		`session_name: "${title}"`,
		`cwd: ${session.cwd}`,
		`date: ${date}`,
		`project: ${project}`,
		`parent: ${segment.parentName ? `"[[${segment.parentName}]]"` : "~"}`,
		`status: ${segment.status}`,
		`message_count: ${meta.messageCount}`,
		`tools_used: [${meta.toolsUsed.join(", ")}]`,
		`tags: [session, ${segment.status}]`,
		`content_hash: PENDING`,
		"---",
		"",
	].join("\n");

	const body = segment.entries
		.filter((e) => e.type === "message")
		.map((e) => renderMessage(e as MessageEntry))
		.filter(Boolean)
		.join("\n\n");

	return frontmatter + body + "\n";
}

function renderMessage(entry: MessageEntry): string {
	const msg = entry.message;

	switch (msg.role) {
		case "user":
			return callout("quote", "User", extractText(msg.content));

		case "assistant":
			return renderAssistant(msg.content ?? []);

		case "toolResult":
			return renderToolResult(msg);

		case "bashExecution":
			return callout("warning", `Bash: \`${msg.command}\``, `exit ${msg.exitCode}`, true);

		default:
			return "";
	}
}

function renderAssistant(content: ContentPart[]): string {
	const textParts: string[] = [];
	const toolParts: string[] = [];

	for (const c of content) {
		if (c.type === "text" && c.text) {
			textParts.push(c.text);
		} else if (c.type === "toolCall") {
			const args = formatToolCallArgs(c.name ?? "", c.arguments);
			const title = `${c.name} ${args}`.trim();
			toolParts.push(callout("example", title, "", true));
		}
		// Skip thinking blocks
	}

	if (textParts.length === 0 && toolParts.length === 0) return "";

	const result: string[] = [];
	if (textParts.length > 0) {
		result.push(callout("info", "Assistant", textParts.join("\n\n")));
	}
	result.push(...toolParts);
	return result.join("\n\n");
}

function renderToolResult(msg: MessageEntry["message"]): string {
	const text = extractText(msg.content).trim();
	const toolName = msg.toolName ?? "";

	if (!text) return callout("note", "Result", "(empty)", true);

	if (toolName === "write" || toolName === "edit") {
		return callout("note", "Result", text.split("\n")[0], true);
	}

	const lineCount = text.split("\n").length;
	if (lineCount > 3) {
		return callout("note", "Result", `(${lineCount} lines)`, true);
	}
	if (text.length > 120) {
		return callout("note", "Result", text.slice(0, 117) + "...", true);
	}
	return callout("note", "Result", text, true);
}

/**
 * Obsidian callout block.
 * @param collapsed true = collapsed by default (-), false = expanded (+)
 */
function callout(type: string, title: string, content: string, collapsed = false): string {
	const flag = collapsed ? "-" : "+";
	const header = `> [!${type}]${flag} ${title}`;
	if (!content) return header;
	const prefixed = content
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return `${header}\n${prefixed}`;
}

// ── Tool call formatting ─────────────────────────────────────────────────────

function formatToolCallArgs(name: string, args?: Record<string, unknown>): string {
	if (!args) return "";

	switch (name) {
		case "bash":
			return args.command ? `\`${args.command}\`` : "";
		case "read":
			return args.path ? `\`${args.path}\`` : "";
		case "write":
			return args.path ? `\`${args.path}\`` : "";
		case "edit":
			return args.path ? `\`${args.path}\`` : "";
		case "grep": {
			const pattern = args.pattern ? `\`${args.pattern}\`` : "";
			const path = args.path ? ` in \`${args.path}\`` : "";
			return `${pattern}${path}`;
		}
		default: {
			const json = JSON.stringify(args);
			return json.length > 120 ? json.slice(0, 117) + "..." : json;
		}
	}
}

function extractText(content?: ContentPart[]): string {
	if (!content) return "";
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

// ── Session index ────────────────────────────────────────────────────────────

/**
 * Write _index.md for a session directory.
 * Shows the tree structure with wikilinks to each segment.
 */
function buildSessionIndex(outputDir: string, segments: Segment[], session: SessionEntry, sessionName: string | null): string {
	const date = session.timestamp?.slice(0, 10) ?? "";
	const project = session.cwd.split("/").filter(Boolean).pop() ?? "";
	const title = sessionName ?? basename(outputDir);

	const lines = [
		"---",
		`tags: [session-index]`,
		`date: ${date}`,
		`project: ${project}`,
		sessionName ? `session_name: "${sessionName}"` : null,
		`cwd: ${session.cwd}`,
		`session_id: ${session.id}`,
		"---",
		"",
		`# ${title}`,
		"",
		`**Project:** ${project}`,
		`**Date:** ${date}`,
		`**CWD:** \`${session.cwd}\``,
		"",
		"## Tree",
		"",
	].filter((l): l is string => l !== null);

	// Build tree from segments
	const byName = new Map(segments.map((s) => [s.name, s]));
	const childrenOfSeg = new Map<string | null, Segment[]>();
	for (const s of segments) {
		let kids = childrenOfSeg.get(s.parentName);
		if (!kids) {
			kids = [];
			childrenOfSeg.set(s.parentName, kids);
		}
		kids.push(s);
	}

	function renderTree(parentName: string | null, indent: number): void {
		const children = childrenOfSeg.get(parentName) ?? [];
		for (const seg of children) {
			const meta = computeSegmentMeta(seg);
			const prefix = "  ".repeat(indent) + "-";
			const statusIcon = seg.status === "abandoned" ? "🚫" : "✅";
			const msgInfo = meta.messageCount > 0 ? `, ${meta.messageCount} msgs` : "";
			lines.push(`${prefix} ${statusIcon} [[${seg.name}]] (${seg.status}${msgInfo})`);
			renderTree(seg.name, indent + 1);
		}
	}

	renderTree(null, 0);
	lines.push("");

	return lines.join("\n");
}

// ── Canvas generation ────────────────────────────────────────────────────────

interface CanvasNode {
	id: string;
	type: "text";
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
}

interface CanvasEdge {
	id: string;
	fromNode: string;
	toNode: string;
	fromSide: string;
	toSide: string;
}

/**
 * Write _tree.canvas for sessions with forks.
 * Nodes are text nodes with wikilinks, laid out as a vertical tree.
 */
function buildSessionCanvas(segments: Segment[]): string {
	const NODE_W = 300;
	const NODE_H = 60;
	const GAP_X = 40;
	const GAP_Y = 120;

	// Build segment tree
	const childrenOfSeg = new Map<string | null, Segment[]>();
	for (const s of segments) {
		let kids = childrenOfSeg.get(s.parentName);
		if (!kids) {
			kids = [];
			childrenOfSeg.set(s.parentName, kids);
		}
		kids.push(s);
	}

	// Compute subtree widths (for centering parents over children)
	const subtreeWidth = new Map<string, number>();

	function computeWidth(name: string): number {
		const children = childrenOfSeg.get(name) ?? [];
		if (children.length === 0) {
			subtreeWidth.set(name, NODE_W);
			return NODE_W;
		}
		const totalChildWidth = children.reduce((sum, c) => sum + computeWidth(c.name), 0);
		const gaps = (children.length - 1) * GAP_X;
		const w = Math.max(NODE_W, totalChildWidth + gaps);
		subtreeWidth.set(name, w);
		return w;
	}

	// Compute widths for all root segments
	const roots = childrenOfSeg.get(null) ?? [];
	for (const r of roots) computeWidth(r.name);

	// Layout nodes
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];

	function layout(name: string, x: number, y: number): void {
		const seg = segments.find((s) => s.name === name);
		if (!seg) return;

		const myWidth = subtreeWidth.get(name) ?? NODE_W;
		const nodeX = x + (myWidth - NODE_W) / 2;
		const meta = computeSegmentMeta(seg);
		const msgInfo = meta.messageCount > 0 ? ` (${meta.messageCount} msgs)` : "";

		nodes.push({
			id: name,
			type: "text",
			text: `[[${name}]]${msgInfo}`,
			x: nodeX,
			y,
			width: NODE_W,
			height: NODE_H,
			color: seg.status === "abandoned" ? "1" : "4", // red vs green
		});

		const children = childrenOfSeg.get(name) ?? [];
		if (children.length === 0) return;

		let childX = x;
		for (const child of children) {
			const childWidth = subtreeWidth.get(child.name) ?? NODE_W;
			layout(child.name, childX, y + NODE_H + GAP_Y);
			edges.push({
				id: `${name}-${child.name}`,
				fromNode: name,
				toNode: child.name,
				fromSide: "bottom",
				toSide: "top",
			});
			childX += childWidth + GAP_X;
		}
	}

	let startX = 0;
	for (const r of roots) {
		layout(r.name, startX, 0);
		startX += (subtreeWidth.get(r.name) ?? NODE_W) + GAP_X;
	}

	return JSON.stringify({ nodes, edges }, null, 2);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function pad(n: number): string {
	return String(n).padStart(3, "0");
}

/** Write file only if content differs from what's on disk. */
function writeIfChanged(filePath: string, content: string): void {
	if (existsSync(filePath)) {
		const existing = readFileSync(filePath, "utf-8");
		if (existing === content) return;
	}
	writeFileSync(filePath, content);
}

function contentHash(md: string): string {
	const filtered = md
		.split("\n")
		.filter((l) => !l.startsWith("content_hash:"))
		.join("\n");
	return createHash("sha256").update(filtered).digest("hex").slice(0, 12);
}

function extractFrontmatterField(content: string, field: string): string | null {
	const re = new RegExp(`^${field}:\\s*"([^"]+)"$|^${field}:\\s*(\\S+)$`, "m");
	const match = content.match(re);
	return match?.[1] ?? match?.[2] ?? null;
}
