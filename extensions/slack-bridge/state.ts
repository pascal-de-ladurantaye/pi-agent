/**
 * Session-tree persistence for the Slack bridge.
 *
 * Every record is a `custom` entry with customType `slack-bridge`. Records carry
 * the id of the session that wrote them. A forked or cloned session file copies
 * its parent's entries but gets a new session id, so the copied records are
 * ignored and the fork starts unbound.
 *
 * State is rebuilt from every entry in the file (`getEntries()`), not from the
 * current branch: a thread and the Slack messages already posted to it exist no
 * matter which branch is checked out.
 */

export const ENTRY_TYPE = "slack-bridge";

export type BridgeRecord =
	| { kind: "bind"; sessionId: string; channel: string; threadTs: string; userId: string }
	| { kind: "off"; sessionId: string; threadTs: string }
	| { kind: "post"; sessionId: string; threadTs: string; ts: string; role: "user" | "assistant" | "system" }
	| { kind: "inbound"; sessionId: string; threadTs: string; ts: string }
	| { kind: "notice"; sessionId: string; ts: string; deleted?: boolean };

export interface ThreadState {
	channel: string;
	threadTs: string;
	userId: string;
	/** True while mirroring is on. False after `/slack off`. */
	active: boolean;
	/** Every message ts the bridge posted in this thread (echo protection). */
	posted: Set<string>;
	/** Replies already delivered to the agent. */
	consumed: Set<string>;
	/** Highest consumed reply ts (or the thread ts). Replies at or below it are old. */
	cursor: string;
}

export interface RebuiltState {
	/** Latest thread bound by this session, active or not. */
	thread: ThreadState | undefined;
	/** Channel-level notice messages that have not been deleted yet. */
	notices: string[];
	/** True when the file holds records from another session (a fork or clone). */
	inheritedFromOtherSession: boolean;
}

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export function isRecord(value: unknown): value is BridgeRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.kind === "string" && typeof v.sessionId === "string";
}

/** Compare Slack timestamps ("1712345678.000100") numerically. */
export function tsCompare(a: string, b: string): number {
	const [as, af = ""] = a.split(".");
	const [bs, bf = ""] = b.split(".");
	if (as.length !== bs.length) return as.length - bs.length;
	if (as !== bs) return as < bs ? -1 : 1;
	const fa = af.padEnd(6, "0");
	const fb = bf.padEnd(6, "0");
	return fa === fb ? 0 : fa < fb ? -1 : 1;
}

export function maxTs(a: string, b: string): string {
	return tsCompare(a, b) >= 0 ? a : b;
}

export function rebuildState(entries: readonly EntryLike[], sessionId: string): RebuiltState {
	const threads = new Map<string, ThreadState>();
	const notices = new Set<string>();
	let latest: string | undefined;
	let inherited = false;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isRecord(entry.data)) continue;
		const record = entry.data;
		if (record.sessionId !== sessionId) {
			inherited = true;
			continue;
		}
		switch (record.kind) {
			case "bind": {
				const existing = threads.get(record.threadTs);
				const thread = existing ?? {
					channel: record.channel,
					threadTs: record.threadTs,
					userId: record.userId,
					active: true,
					posted: new Set<string>(),
					consumed: new Set<string>(),
					cursor: record.threadTs,
				};
				thread.active = true;
				threads.set(record.threadTs, thread);
				latest = record.threadTs;
				break;
			}
			case "off": {
				const thread = threads.get(record.threadTs);
				if (thread) thread.active = false;
				break;
			}
			case "post": {
				const thread = threads.get(record.threadTs);
				if (!thread) break;
				// Posts do not move the cursor: a reply typed in Slack just before a
				// bridge post has a lower ts and must still be picked up.
				thread.posted.add(record.ts);
				break;
			}
			case "inbound": {
				const thread = threads.get(record.threadTs);
				if (!thread) break;
				thread.consumed.add(record.ts);
				thread.cursor = maxTs(thread.cursor, record.ts);
				break;
			}
			case "notice":
				if (record.deleted) notices.delete(record.ts);
				else notices.add(record.ts);
				break;
		}
	}

	return {
		thread: latest ? threads.get(latest) : undefined,
		notices: [...notices],
		inheritedFromOtherSession: inherited,
	};
}

export interface SlackReply {
	ts: string;
	user?: string;
	text?: string;
	subtype?: string;
	bot_id?: string;
	thread_ts?: string;
	metadata?: { event_type?: string };
}

export const METADATA_EVENT = "pi_slack_bridge";

/**
 * Pick the thread replies that should become agent turns: newer than the cursor,
 * written by the bound user, not posted by the bridge itself, and not already
 * consumed. Ordered oldest first.
 */
export function selectInbound(replies: readonly SlackReply[], thread: ThreadState): SlackReply[] {
	return replies
		.filter((r) => r.ts !== thread.threadTs)
		.filter((r) => tsCompare(r.ts, thread.cursor) > 0)
		.filter((r) => r.user === thread.userId && !r.bot_id)
		.filter((r) => !r.subtype || r.subtype === "thread_broadcast")
		.filter((r) => r.metadata?.event_type !== METADATA_EVENT)
		.filter((r) => !thread.posted.has(r.ts) && !thread.consumed.has(r.ts))
		.filter((r) => (r.text ?? "").trim() !== "")
		.sort((a, b) => tsCompare(a.ts, b.ts));
}
