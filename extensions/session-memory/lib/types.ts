// ── Extension config ─────────────────────────────────────────────────────────

export interface SessionMemoryConfig {
	vaultPath: string;
}

// ── JSONL entry types ────────────────────────────────────────────────────────

export interface BaseEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionEntry extends BaseEntry {
	type: "session";
	version: number;
	cwd: string;
}

export interface MessageEntry extends BaseEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult" | "bashExecution";
		content?: ContentPart[];
		// toolResult fields
		toolCallId?: string;
		toolName?: string;
		details?: Record<string, unknown>;
		// bashExecution fields
		command?: string;
		output?: string;
		exitCode?: number;
	};
}

export interface ContentPart {
	type: "text" | "thinking" | "toolCall" | "image";
	text?: string;
	// toolCall fields
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface ModelChangeEntry extends BaseEntry {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface CustomEntry extends BaseEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface SessionInfoEntry extends BaseEntry {
	type: "session_info";
	name?: string;
}

export type Entry = SessionEntry | MessageEntry | ModelChangeEntry | CustomEntry | SessionInfoEntry | BaseEntry;

// ── Conversion types ─────────────────────────────────────────────────────────

export interface Segment {
	/** e.g. "001", "002a", "002b" */
	name: string;
	/** parent segment name, null for root */
	parentName: string | null;
	/** entries in this segment (in tree order) */
	entries: Entry[];
	/** active = on the current branch, abandoned = forked away */
	status: "active" | "abandoned";
}

/** Metadata extracted from a segment for richer frontmatter. */
export interface SegmentMeta {
	messageCount: number;
	toolsUsed: string[];
}

export interface ConvertResult {
	/** output directory name under raw/ */
	sessionDir: string;
	/** number of segment files written (new or changed) */
	written: number;
	/** number of segment files skipped (unchanged) */
	skipped: number;
	/** total segments (written + skipped) */
	total: number;
	/** whether the session has forks */
	hasForks: boolean;
	/** whether this is the first time this session was converted */
	isNewSession: boolean;
}
