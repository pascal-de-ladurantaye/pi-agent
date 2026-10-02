/**
 * Slack bridge controller. Owns one Slack thread for one pi session, mirrors
 * user and assistant text into it, and turns replies typed in the thread into
 * agent turns. All Slack calls run through one serial queue so a poll never
 * races a post (echo protection depends on knowing every ts we posted).
 */

import { slackToPlain, splitMarkdown, toMrkdwn } from "./mrkdwn.ts";
import type { BridgeConfig, SlackApi } from "./slack.ts";
import { AUTH_ERRORS, SlackError } from "./slack.ts";
import {
	type BridgeRecord,
	METADATA_EVENT,
	type SlackReply,
	type ThreadState,
	maxTs,
	rebuildState,
	selectInbound,
	tsCompare,
} from "./state.ts";

export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export interface BridgeHost {
	sessionId(): string;
	entries(): readonly EntryLike[];
	append(record: BridgeRecord): void;
	sendUserMessage(text: string, deliverAs?: "followUp"): void;
	isIdle(): boolean;
	editorText(): string;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setStatus(text: string | undefined): void;
	describe(): { cwd: string; name?: string; model?: string };
}

export interface BridgeOptions {
	pollActiveMs: number;
	pollIdleMs: number;
	activeWindowMs: number;
	editThrottleMs: number;
	partLimit: number;
	now: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

export const DEFAULT_OPTIONS: BridgeOptions = {
	pollActiveMs: 5_000,
	pollIdleMs: 30_000,
	activeWindowMs: 10 * 60_000,
	editThrottleMs: 2_500,
	partLimit: 12_000,
	now: () => Date.now(),
	setTimer: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return handle;
	},
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Status = "idle" | "working" | "waiting for a terminal dialog" | "reply held: unsent draft in the terminal" | "off" | "ended";

interface Segment {
	done: string[];
	live: string;
	tool?: string;
	parts: string[]; // posted message ts, in order
	rendered: string[]; // last text sent for each part
	lastRender: number;
	timer?: unknown;
}

const EDIT_ERRORS = new Set(["cant_update_message", "edit_window_closed", "message_not_found"]);

export function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => !!part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export type ConfigLoader = () => { api: SlackApi; config: BridgeConfig };

export class SlackBridge {
	private api: SlackApi | undefined;
	private config: BridgeConfig | undefined;
	private thread: ThreadState | undefined;
	private notices: string[] = [];
	private running = false;
	private queue: Promise<void> = Promise.resolve();
	private pollTimer: unknown;
	private pollCursor = "";
	private pending: SlackReply[] = [];
	private injected: string[] = [];
	private segment: Segment | undefined;
	private status: Status = "idle";
	private headerSent = "";
	private agentBusy = false;
	private promptOpen = 0;
	private lastActivity = 0;
	private permalink: string | undefined;
	private reportedErrors = new Set<string>();
	private nextUserSource: string | undefined;
	private authFailed = false;
	private readonly options: BridgeOptions;

	constructor(
		private readonly host: BridgeHost,
		private readonly loadApi: ConfigLoader,
		options: Partial<BridgeOptions> = {},
	) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	// ---------------------------------------------------------------- lifecycle

	/** Rebuild from the whole session tree. Called on every session_start. */
	load(reason: string): void {
		const state = rebuildState(this.host.entries(), this.host.sessionId());
		this.thread = state.thread;
		this.notices = state.notices;
		if (state.inheritedFromOtherSession && !state.thread && reason === "fork") {
			this.host.notify("This fork was copied from a session mirrored to Slack. Run /slack on to give it its own thread.", "info");
		}
		if (this.thread?.active) {
			try {
				this.connect();
			} catch (error) {
				this.host.notify(`Slack bridge not started: ${(error as Error).message} Run /slack auth to paste fresh credentials.`, "warning");
				this.host.setStatus("slack: config error");
				return;
			}
			this.start();
			this.setStatus("idle");
		}
	}

	async shutdown(reason: string): Promise<void> {
		if (!this.running) return;
		this.stopPolling();
		if (this.segment?.timer !== undefined) this.options.clearTimer(this.segment.timer);
		if (reason !== "reload") {
			if (this.segment) this.enqueue(() => this.renderSegment(true));
			this.setStatus("ended");
		}
		this.running = false;
		await Promise.race([this.queue, new Promise((resolve) => this.options.setTimer(() => resolve(undefined), 3_000))]);
	}

	// ----------------------------------------------------------------- commands

	async on(forceNew = false): Promise<string> {
		if (this.running && this.thread?.active && !forceNew) return "Already mirroring to Slack.";
		this.connect();
		const api = this.api!;
		const sessionId = this.host.sessionId();
		// Check the token up front so an expired one is caught here, where the
		// command can offer to sign in again.
		const auth = await api.call<{ user_id: string }>("auth.test");
		this.authFailed = false;

		if (this.thread && !forceNew) {
			// Continue the previous thread for this session.
			this.host.append({ kind: "bind", sessionId, channel: this.thread.channel, threadTs: this.thread.threadTs, userId: this.thread.userId });
			this.thread.active = true;
		} else {
			if (this.running) await this.off();
			const channel = this.config!.channel ?? (await api.call<{ channel: { id: string } }>("conversations.open", { users: auth.user_id })).channel.id;
			const header = this.headerText("idle");
			const posted = await api.call<{ ts: string }>("chat.postMessage", {
				channel,
				text: header,
				unfurl_links: false,
				unfurl_media: false,
				metadata: { event_type: METADATA_EVENT, event_payload: { session: sessionId } },
			});
			this.host.append({ kind: "bind", sessionId, channel, threadTs: posted.ts, userId: auth.user_id });
			this.thread = {
				channel,
				threadTs: posted.ts,
				userId: auth.user_id,
				active: true,
				posted: new Set(),
				consumed: new Set(),
				cursor: posted.ts,
			};
			this.pollCursor = posted.ts;
			this.pending = [];
			this.headerSent = header;
			this.permalink = undefined;
		}
		this.start();
		this.setStatus(this.agentBusy ? "working" : "idle");
		return "Mirroring this session to a thread in your Slack DM.";
	}

	async off(): Promise<string> {
		if (!this.thread?.active) return "Slack mirroring is already off.";
		if (this.segment) this.enqueue(() => this.renderSegment(true));
		this.host.append({ kind: "off", sessionId: this.host.sessionId(), threadTs: this.thread.threadTs });
		this.thread.active = false;
		this.setStatus("off");
		this.stopPolling();
		this.running = false;
		this.host.setStatus(undefined);
		await this.queue;
		return "Stopped mirroring. /slack on continues in the same thread.";
	}

	/** Whether the last Slack call failed because the token was rejected. */
	needsAuth(): boolean {
		return this.authFailed;
	}

	/**
	 * Reload the config after the credentials changed. Resumes mirroring if this
	 * session's thread is on, including after an auth error stopped it.
	 */
	reconnect(): string {
		this.connect();
		this.authFailed = false;
		if (!this.thread?.active) return "Credentials saved. Run /slack on to start mirroring.";
		if (!this.running) this.start();
		this.headerSent = "";
		this.setStatus(this.agentBusy ? "working" : "idle");
		this.deliverPending();
		return "Credentials saved. Mirroring resumed.";
	}

	describeStatus(): string {
		if (!this.thread) return "Not mirrored. Run /slack on.";
		const lines = [
			`thread: ${this.thread.channel}/${this.thread.threadTs}`,
			`mirroring: ${this.thread.active ? (this.running ? "on" : this.authFailed ? "on, but Slack rejected the token (run /slack auth)" : "on, but not connected") : "off"}`,
			`posted messages: ${this.thread.posted.size}, replies delivered: ${this.thread.consumed.size}, replies waiting: ${this.pending.length}`,
		];
		if (this.running) lines.push(`poll interval: ${this.pollInterval() / 1000}s`);
		return lines.join("\n");
	}

	// ------------------------------------------------------------- agent events

	onInput(source: string): void {
		this.nextUserSource = source;
	}

	onUserMessage(message: { content?: unknown }): void {
		const source = this.nextUserSource;
		this.nextUserSource = undefined;
		if (!this.isMirroring()) return;
		this.finishSegment();
		const text = messageText(message).trim();
		if (!text) return;
		const injectedAt = this.injected.findIndex((t) => t.trim() === text);
		if (injectedAt !== -1) {
			this.injected.splice(injectedAt, 1);
			return; // came from Slack; already in the thread
		}
		const label = source === "extension" ? "*extension prompt*" : "*you, in the terminal*";
		this.touch();
		this.enqueue(() => this.postMarkdown(text, label, "user"));
	}

	onAgentStart(): void {
		this.agentBusy = true;
		if (this.isMirroring()) this.setStatus("working");
	}

	onAssistantUpdate(message: { content?: unknown }): void {
		if (!this.isMirroring()) return;
		const seg = this.ensureSegment();
		seg.live = messageText(message);
		this.scheduleRender();
	}

	onAssistantEnd(message: { content?: unknown; stopReason?: string; errorMessage?: string }): void {
		if (!this.isMirroring()) return;
		const seg = this.ensureSegment();
		let text = messageText(message).trim();
		if (message.stopReason === "error" && message.errorMessage) text = `${text}\n\n_error: ${message.errorMessage}_`.trim();
		if (message.stopReason === "aborted") text = `${text}\n\n_stopped_`.trim();
		if (text) seg.done.push(text);
		seg.live = "";
		this.scheduleRender();
	}

	onToolStart(name: string, nested: boolean): void {
		if (!this.isMirroring() || nested) return;
		this.ensureSegment().tool = name;
		this.scheduleRender();
	}

	onToolEnd(nested: boolean): void {
		if (!this.segment || nested) return;
		this.segment.tool = undefined;
	}

	onSettled(): void {
		this.agentBusy = false;
		if (!this.isMirroring()) return;
		const hadReply = !!this.segment && this.segmentMarkdown(this.segment) !== "";
		this.finishSegment();
		this.setStatus("idle");
		if (hadReply && this.config?.notifyOnSettle) this.enqueue(() => this.postNotice());
		this.deliverPending();
	}

	onPrompt(open: boolean): void {
		this.promptOpen = Math.max(0, this.promptOpen + (open ? 1 : -1));
		if (!this.isMirroring()) return;
		if (this.promptOpen && this.pending.length) this.setStatus("waiting for a terminal dialog");
		if (!this.promptOpen) this.deliverPending();
	}

	onTreeNavigated(): void {
		if (!this.isMirroring()) return;
		this.finishSegment();
		this.enqueue(async () => {
			await this.postRaw("_switched to another branch of the session tree_", "system");
		});
	}

	onSessionInfoChanged(): void {
		if (this.isMirroring()) this.setStatus(this.status);
	}

	// ---------------------------------------------------------------- internals

	private isMirroring(): boolean {
		return this.running && !!this.thread?.active;
	}

	private connect(): void {
		const { api, config } = this.loadApi();
		this.api = api;
		this.config = config;
	}

	private start(): void {
		if (!this.thread) return;
		this.running = true;
		this.pollCursor = maxTs(this.pollCursor || this.thread.cursor, this.thread.cursor);
		this.reportedErrors.clear();
		this.host.setStatus("slack");
		this.touch();
		this.schedulePoll(0);
	}

	private touch(): void {
		this.lastActivity = this.options.now();
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((error) => this.reportError(error));
	}

	private reportError(error: unknown): void {
		const code = error instanceof SlackError ? error.code : (error as Error)?.message ?? String(error);
		if (error instanceof SlackError && AUTH_ERRORS.has(code)) {
			this.stopPolling();
			this.running = false;
			this.authFailed = true;
			this.host.setStatus("slack: auth error");
			this.host.notify(`Slack rejected the token (${code}). Run /slack auth and paste a fresh curl from your browser.`, "error");
			return;
		}
		if (error instanceof SlackError && code === "thread_not_found") {
			this.stopPolling();
			this.running = false;
			this.host.setStatus("slack: thread gone");
			this.host.notify("The Slack thread for this session is gone. Run /slack on new to start another.", "warning");
			return;
		}
		if (this.reportedErrors.has(code)) return;
		this.reportedErrors.add(code);
		this.host.notify(`Slack bridge: ${code}`, "warning");
	}

	// ------------------------------------------------------------------ posting

	private record(ts: string, role: "user" | "assistant" | "system"): void {
		const thread = this.thread!;
		thread.posted.add(ts);
		this.host.append({ kind: "post", sessionId: this.host.sessionId(), threadTs: thread.threadTs, ts, role });
	}

	private async postRaw(text: string, role: "user" | "assistant" | "system"): Promise<string> {
		const thread = this.thread!;
		const posted = await this.api!.call<{ ts: string }>("chat.postMessage", {
			channel: thread.channel,
			thread_ts: thread.threadTs,
			text,
			unfurl_links: false,
			unfurl_media: false,
			metadata: { event_type: METADATA_EVENT, event_payload: { role } },
		});
		this.record(posted.ts, role);
		return posted.ts;
	}

	private renderParts(markdown: string, label: string, footer = ""): string[] {
		const chunks = splitMarkdown(markdown, this.options.partLimit);
		return chunks.map((chunk, i) => {
			const head = [i === 0 ? label : "", chunks.length > 1 ? `_part ${i + 1}/${chunks.length}_` : ""].filter(Boolean).join(" ");
			const tail = i === chunks.length - 1 && footer ? `\n${footer}` : "";
			return `${head ? `${head}\n` : ""}${toMrkdwn(chunk)}${tail}`;
		});
	}

	private async postMarkdown(markdown: string, label: string, role: "user" | "assistant"): Promise<void> {
		for (const part of this.renderParts(markdown, label)) await this.postRaw(part, role);
	}

	private ensureSegment(): Segment {
		this.segment ??= { done: [], live: "", parts: [], rendered: [], lastRender: 0 };
		return this.segment;
	}

	private segmentMarkdown(seg: Segment): string {
		return [...seg.done, seg.live.trim()].filter(Boolean).join("\n\n");
	}

	private scheduleRender(): void {
		const seg = this.segment;
		if (!seg || seg.timer !== undefined) return;
		const delay = Math.max(0, seg.lastRender + this.options.editThrottleMs - this.options.now());
		seg.timer = this.options.setTimer(() => {
			seg.timer = undefined;
			if (this.segment === seg) this.enqueue(() => this.renderSegment(false, seg));
		}, delay);
	}

	private finishSegment(): void {
		const seg = this.segment;
		if (!seg) return;
		if (seg.timer !== undefined) {
			this.options.clearTimer(seg.timer);
			seg.timer = undefined;
		}
		this.segment = undefined;
		if (this.isMirroring()) this.enqueue(() => this.renderSegment(true, seg));
	}

	private async renderSegment(final: boolean, seg: Segment | undefined = this.segment): Promise<void> {
		if (!seg) return;
		const markdown = this.segmentMarkdown(seg);
		if (!markdown) return;
		seg.lastRender = this.options.now();
		const footer = final ? "" : seg.tool ? `_working: running \`${seg.tool}\`_` : "_working_";
		const parts = this.renderParts(markdown, "*pi*", footer);
		const thread = this.thread!;
		for (let i = 0; i < parts.length; i++) {
			if (seg.rendered[i] === parts[i]) continue;
			const ts = seg.parts[i];
			if (ts) {
				try {
					await this.api!.call("chat.update", { channel: thread.channel, ts, text: parts[i] });
					seg.rendered[i] = parts[i];
					continue;
				} catch (error) {
					if (!(error instanceof SlackError && EDIT_ERRORS.has(error.code))) throw error;
					// Edit window closed: continue the reply in a new message.
				}
			}
			seg.parts[i] = await this.postRaw(parts[i], "assistant");
			seg.rendered[i] = parts[i];
		}
		this.touch();
	}

	// ---------------------------------------------------------- header + notice

	private headerText(status: Status): string {
		const info = this.host.describe();
		const name = info.name || `session ${this.host.sessionId().slice(0, 8)}`;
		const meta = [`\`${info.cwd}\``, info.model].filter(Boolean).join(" · ");
		return `*pi: ${toMrkdwn(name).replace(/\n/g, " ")}*\n${meta}\nstatus: *${status}*`;
	}

	private setStatus(status: Status): void {
		this.status = status;
		if (!this.thread || !this.api) return;
		const text = this.headerText(status);
		if (text === this.headerSent) return;
		this.headerSent = text;
		const thread = this.thread;
		this.enqueue(async () => {
			if (this.headerSent !== text) return; // superseded
			await this.api!.call("chat.update", { channel: thread.channel, ts: thread.threadTs, text });
		});
	}

	private async postNotice(): Promise<void> {
		const thread = this.thread!;
		const sessionId = this.host.sessionId();
		if (!this.permalink) {
			const link = await this.api!.call<{ permalink: string }>("chat.getPermalink", { channel: thread.channel, message_ts: thread.threadTs });
			this.permalink = link.permalink;
		}
		for (const ts of this.notices.splice(0)) {
			try {
				await this.api!.call("chat.delete", { channel: thread.channel, ts });
			} catch (error) {
				if (!(error instanceof SlackError && error.code === "message_not_found")) throw error;
			}
			this.host.append({ kind: "notice", sessionId, ts, deleted: true });
		}
		const info = this.host.describe();
		const name = info.name || `session ${sessionId.slice(0, 8)}`;
		const posted = await this.api!.call<{ ts: string }>("chat.postMessage", {
			channel: thread.channel,
			text: `pi finished a turn in *${toMrkdwn(name).replace(/\n/g, " ")}*: <${this.permalink}|open thread>`,
			unfurl_links: false,
			unfurl_media: false,
			metadata: { event_type: METADATA_EVENT, event_payload: { role: "notice" } },
		});
		this.notices.push(posted.ts);
		this.host.append({ kind: "notice", sessionId, ts: posted.ts });
	}

	// ------------------------------------------------------------------ polling

	private pollInterval(): number {
		const active = this.options.now() - this.lastActivity < this.options.activeWindowMs || this.agentBusy;
		return active ? this.options.pollActiveMs : this.options.pollIdleMs;
	}

	private schedulePoll(ms = this.pollInterval()): void {
		this.stopPolling();
		if (!this.running) return;
		this.pollTimer = this.options.setTimer(() => {
			this.pollTimer = undefined;
			this.enqueue(() => this.poll());
			this.queue = this.queue.finally(() => this.running && this.pollTimer === undefined && this.schedulePoll());
		}, ms);
	}

	private stopPolling(): void {
		if (this.pollTimer !== undefined) this.options.clearTimer(this.pollTimer);
		this.pollTimer = undefined;
	}

	/** Fetch new thread replies, then try to deliver waiting ones. */
	async poll(): Promise<void> {
		const thread = this.thread;
		if (!this.isMirroring() || !thread) return;
		const replies: SlackReply[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const res = await this.api!.call<{ messages?: SlackReply[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
				"conversations.replies",
				{ channel: thread.channel, ts: thread.threadTs, oldest: this.pollCursor, inclusive: false, limit: 200, include_all_metadata: true, cursor },
			);
			replies.push(...(res.messages ?? []));
			cursor = res.response_metadata?.next_cursor;
			if (!res.has_more || !cursor) break;
		}
		const known = new Set(this.pending.map((r) => r.ts));
		for (const reply of selectInbound(replies, thread)) {
			if (!known.has(reply.ts)) this.pending.push(reply);
		}
		for (const reply of replies) {
			if (reply.ts !== thread.threadTs) this.pollCursor = maxTs(this.pollCursor, reply.ts);
		}
		this.pending.sort((a, b) => tsCompare(a.ts, b.ts));
		this.deliverPending();
	}

	private deliverPending(): void {
		const thread = this.thread;
		if (!this.isMirroring() || !thread || !this.pending.length) return;
		if (this.promptOpen) {
			this.setStatus("waiting for a terminal dialog");
			return;
		}
		if (this.host.editorText().trim()) {
			if (this.status !== "reply held: unsent draft in the terminal") {
				this.host.notify("A Slack reply is waiting. Send or clear your draft to let it through.", "info");
			}
			this.setStatus("reply held: unsent draft in the terminal");
			return;
		}
		if (this.status === "reply held: unsent draft in the terminal" || this.status === "waiting for a terminal dialog") {
			this.setStatus(this.agentBusy ? "working" : "idle");
		}

		while (this.pending.length) {
			const idle = this.host.isIdle() && !this.agentBusy;
			const reply = this.pending.shift()!;
			const text = slackToPlain(reply.text ?? "").trim();
			// Record before delivery: a crash may drop a reply, never repeat one.
			thread.consumed.add(reply.ts);
			thread.cursor = maxTs(thread.cursor, reply.ts);
			this.host.append({ kind: "inbound", sessionId: this.host.sessionId(), threadTs: thread.threadTs, ts: reply.ts });
			this.injected.push(text);
			this.touch();
			try {
				if (idle) this.host.sendUserMessage(text);
				else this.host.sendUserMessage(text, "followUp");
			} catch (error) {
				this.injected.pop();
				this.host.notify(`Could not deliver Slack reply: ${(error as Error).message}`, "warning");
				continue;
			}
			this.enqueue(async () => {
				try {
					await this.api!.call("reactions.add", { channel: thread.channel, timestamp: reply.ts, name: "white_check_mark" });
				} catch (error) {
					if (!(error instanceof SlackError && error.code === "already_reacted")) throw error;
				}
			});
			// After starting a turn from idle, queue the rest on the next tick as follow-ups.
			if (idle) {
				this.agentBusy = true;
				break;
			}
		}
	}
}
