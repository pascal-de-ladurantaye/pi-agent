import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "@mariozechner/jiti";

const jiti = createJiti(new URL("../../test.cjs", import.meta.url).pathname);
const { toMrkdwn, splitMarkdown, slackToPlain, convertInline } = jiti("./extensions/slack-bridge/mrkdwn.ts");
const { rebuildState, selectInbound, tsCompare, ENTRY_TYPE, METADATA_EVENT } = jiti("./extensions/slack-bridge/state.ts");
const { loadConfig, SlackClient, SlackError } = jiti("./extensions/slack-bridge/slack.ts");
const { SlackBridge } = jiti("./extensions/slack-bridge/bridge.ts");

describe("toMrkdwn", () => {
	it("converts emphasis, strike and links", () => {
		assert.equal(convertInline("**bold** and *it* and _it2_ and ~~gone~~"), "*bold* and _it_ and _it2_ and ~gone~");
		assert.equal(convertInline("***both***"), "*_both_*");
		assert.equal(convertInline("__bold__ snake_case_name"), "*bold* snake_case_name");
		assert.equal(convertInline("see [the docs](https://x.io/a?b=1&c=2)"), "see <https://x.io/a?b=1&c=2|the docs>");
		assert.equal(convertInline("![chart](https://x.io/c.png)"), "<https://x.io/c.png|chart>");
		assert.equal(convertInline("<https://x.io>"), "<https://x.io>");
		assert.equal(convertInline("2 * 3 * 4"), "2 * 3 * 4");
	});

	it("escapes control characters but leaves inline code alone otherwise", () => {
		assert.equal(convertInline("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
		assert.equal(convertInline("run `a **b** <c>` now"), "run `a **b** &lt;c&gt;` now");
	});

	it("converts headings, lists, quotes and rules", () => {
		const md = ["# Title", "## Sub **x**", "- one", "  - nested", "* two", "1. first", "- [ ] todo", "- [x] done", "> quoted *it*", "---"].join("\n");
		assert.equal(
			toMrkdwn(md),
			["*Title*", "*Sub x*", "• one", "    ◦ nested", "• two", "1. first", "☐ todo", "☑ done", "> quoted _it_", "──────────"].join("\n"),
		);
	});

	it("keeps code blocks verbatim, drops the language and escapes", () => {
		const md = "```ts\nconst a = b && c < d; // **not bold**\n```\nafter **x**";
		assert.equal(toMrkdwn(md), "```\nconst a = b &amp;&amp; c &lt; d; // **not bold**\n```\nafter *x*");
	});

	it("closes an unclosed fence (streaming)", () => {
		assert.equal(toMrkdwn("text\n```\npartial"), "text\n```\npartial\n```");
	});

	it("renders tables as aligned code blocks", () => {
		const md = "| Name | Value |\n|---|:--:|\n| **a** | 1 |\n| long name | `22` |";
		assert.equal(toMrkdwn(md), ["```", "Name       Value", "---------  -----", "a          1", "long name  22", "```"].join("\n"));
	});
});

describe("splitMarkdown", () => {
	it("returns short text unchanged", () => {
		assert.deepEqual(splitMarkdown("hello", 100), ["hello"]);
	});

	it("prefers paragraph boundaries and respects the limit", () => {
		const para = (c) => `${c.repeat(30)}\n${c.repeat(30)}`;
		const md = [para("a"), para("b"), para("c"), para("d")].join("\n\n");
		const chunks = splitMarkdown(md, 140);
		assert.ok(chunks.length > 1);
		for (const chunk of chunks) assert.ok(chunk.length <= 140, `chunk too long: ${chunk.length}`);
		assert.ok(chunks[0].endsWith("b".repeat(30)));
		assert.equal(chunks.join("\n\n"), md);
	});

	it("closes and reopens code fences across chunks", () => {
		const body = Array.from({ length: 30 }, (_v, i) => `line ${i} of code`).join("\n");
		const md = `intro\n\n\`\`\`python\n${body}\n\`\`\`\n\nend`;
		const chunks = splitMarkdown(md, 200);
		assert.ok(chunks.length > 2);
		for (const chunk of chunks) {
			assert.ok(chunk.length <= 200);
			const fences = chunk.split("\n").filter((l) => /^(```|~~~)/.test(l)).length;
			assert.equal(fences % 2, 0, `unbalanced fences in:\n${chunk}`);
		}
		assert.ok(chunks[2].startsWith("```python"));
	});

	it("hard-splits very long lines", () => {
		const chunks = splitMarkdown("x".repeat(500), 100);
		assert.ok(chunks.every((c) => c.length <= 100));
		assert.equal(chunks.join(""), "x".repeat(500));
	});
});

describe("slackToPlain", () => {
	it("unwraps links and entities", () => {
		assert.equal(slackToPlain("see <https://a.io|docs> and <https://b.io> &lt;x&gt; &amp; <#C123|eng>"), "see docs (https://a.io) and https://b.io <x> & #eng");
		assert.equal(slackToPlain("<https://a.io|https://a.io>"), "https://a.io");
	});
});

const custom = (data) => ({ type: "custom", customType: ENTRY_TYPE, data });

describe("rebuildState", () => {
	it("reads every entry, keeps posts and replies, and honours off", () => {
		const entries = [
			{ type: "message" },
			custom({ kind: "bind", sessionId: "s1", channel: "D1", threadTs: "100.000100", userId: "U1" }),
			custom({ kind: "post", sessionId: "s1", threadTs: "100.000100", ts: "101.000000", role: "user" }),
			custom({ kind: "inbound", sessionId: "s1", threadTs: "100.000100", ts: "102.000000" }),
			// Same file, a different branch: still the same thread.
			custom({ kind: "post", sessionId: "s1", threadTs: "100.000100", ts: "103.000000", role: "assistant" }),
			custom({ kind: "notice", sessionId: "s1", ts: "104.0" }),
			custom({ kind: "notice", sessionId: "s1", ts: "104.0", deleted: true }),
			custom({ kind: "notice", sessionId: "s1", ts: "105.0" }),
		];
		const state = rebuildState(entries, "s1");
		assert.equal(state.thread.threadTs, "100.000100");
		assert.equal(state.thread.active, true);
		assert.deepEqual([...state.thread.posted], ["101.000000", "103.000000"]);
		assert.equal(state.thread.cursor, "102.000000");
		assert.deepEqual(state.notices, ["105.0"]);
		assert.equal(state.inheritedFromOtherSession, false);

		const off = rebuildState([...entries, custom({ kind: "off", sessionId: "s1", threadTs: "100.000100" })], "s1");
		assert.equal(off.thread.active, false);
		const back = rebuildState(
			[...entries, custom({ kind: "off", sessionId: "s1", threadTs: "100.000100" }), custom({ kind: "bind", sessionId: "s1", channel: "D1", threadTs: "100.000100", userId: "U1" })],
			"s1",
		);
		assert.equal(back.thread.active, true);
		assert.equal(back.thread.posted.size, 2);
	});

	it("ignores records copied from the parent session of a fork", () => {
		const entries = [
			custom({ kind: "bind", sessionId: "parent", channel: "D1", threadTs: "100.0", userId: "U1" }),
			custom({ kind: "post", sessionId: "parent", threadTs: "100.0", ts: "101.0", role: "user" }),
		];
		const state = rebuildState(entries, "fork");
		assert.equal(state.thread, undefined);
		assert.equal(state.inheritedFromOtherSession, true);
	});
});

describe("selectInbound", () => {
	it("filters echoes, other users, old and consumed replies", () => {
		const thread = { channel: "D1", threadTs: "100.0", userId: "U1", active: true, posted: new Set(["103.0"]), consumed: new Set(["104.0"]), cursor: "101.0" };
		const replies = [
			{ ts: "100.0", user: "U1", text: "header" },
			{ ts: "101.0", user: "U1", text: "old" },
			{ ts: "106.0", user: "U1", text: "second" },
			{ ts: "102.0", user: "U1", text: "first" },
			{ ts: "103.0", user: "U1", text: "our post" },
			{ ts: "104.0", user: "U1", text: "consumed" },
			{ ts: "105.0", user: "U2", text: "someone else" },
			{ ts: "107.0", user: "U1", text: "bot", bot_id: "B1" },
			{ ts: "108.0", user: "U1", text: "meta", metadata: { event_type: METADATA_EVENT } },
			{ ts: "109.0", user: "U1", text: "joined", subtype: "channel_join" },
			{ ts: "110.0", user: "U1", text: "  " },
		];
		assert.deepEqual(selectInbound(replies, thread).map((r) => r.text), ["first", "second"]);
	});

	it("compares timestamps numerically", () => {
		assert.ok(tsCompare("99.9", "100.0") < 0);
		assert.ok(tsCompare("100.000010", "100.00001") === 0);
		assert.ok(tsCompare("100.2", "100.10") > 0);
	});
});

describe("config and client", () => {
	it("requires a private file with a valid token", () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-bridge-"));
		const path = join(dir, "config.json");
		assert.throws(() => loadConfig(path), /No config/);
		writeFileSync(path, JSON.stringify({ token: "xoxp-1" }));
		chmodSync(path, 0o644);
		assert.throws(() => loadConfig(path), /chmod 600/);
		chmodSync(path, 0o600);
		assert.equal(loadConfig(path).token, "xoxp-1");
		assert.equal(loadConfig(path).notifyOnSettle, true);
		writeFileSync(path, JSON.stringify({ token: "xoxc-1" }));
		assert.throws(() => loadConfig(path), /cookie/);
		writeFileSync(path, JSON.stringify({ token: "xoxc-1", cookie: "d=xoxd-abc; Path=/" }));
		assert.equal(loadConfig(path).cookie, "xoxd-abc");
		writeFileSync(path, JSON.stringify({ token: "bad" }));
		assert.throws(() => loadConfig(path), /xoxp- or xoxc-/);
	});

	it("sends the cookie, waits out 429 and surfaces API errors", async () => {
		const calls = [];
		const responses = [
			{ status: 429, headers: { get: () => "0" }, json: async () => ({}) },
			{ status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: "1.0" }) },
			{ status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: "channel_not_found" }) },
		];
		const client = new SlackClient({ token: "xoxc-t", cookie: "xoxd-c" }, async (url, init) => {
			calls.push({ url, init });
			return responses.shift();
		});
		const res = await client.call("chat.postMessage", { channel: "D1", metadata: { event_type: "x" } });
		assert.equal(res.ts, "1.0");
		assert.equal(calls.length, 2);
		assert.equal(calls[1].init.headers.Cookie, "d=xoxd-c");
		const body = new URLSearchParams(calls[1].init.body);
		assert.equal(body.get("token"), "xoxc-t");
		assert.equal(body.get("metadata"), '{"event_type":"x"}');
		await assert.rejects(client.call("chat.update"), (error) => error instanceof SlackError && error.code === "channel_not_found");
	});
});

// ------------------------------------------------------------- bridge harness

function harness({ sessionId = "s1", entries = [], editor = "", replies = [] } = {}) {
	let now = 1_000_000;
	let tsSeq = 200;
	const timers = [];
	const calls = [];
	const state = { entries: [...entries], editor, idle: true, sent: [], notes: [], statuses: [], replies: [...replies] };

	const api = {
		async call(method, params = {}) {
			calls.push({ method, params });
			switch (method) {
				case "auth.test":
					return { ok: true, user_id: "U1" };
				case "conversations.open":
					return { ok: true, channel: { id: "D1" } };
				case "chat.postMessage":
					return { ok: true, ts: `${tsSeq++}.000000` };
				case "chat.getPermalink":
					return { ok: true, permalink: "https://slack/p1" };
				case "conversations.replies":
					return { ok: true, messages: state.replies.filter((r) => tsCompare(r.ts, params.oldest) > 0) };
				default:
					return { ok: true };
			}
		},
	};
	const host = {
		sessionId: () => sessionId,
		entries: () => state.entries,
		append: (record) => state.entries.push(custom(record)),
		sendUserMessage: (text, deliverAs) => state.sent.push({ text, deliverAs }),
		isIdle: () => state.idle,
		editorText: () => state.editor,
		notify: (message, level) => state.notes.push({ message, level }),
		setStatus: (text) => state.statuses.push(text),
		describe: () => ({ cwd: "/repo", name: "My session", model: "m1" }),
	};
	const bridge = new SlackBridge(host, () => ({ api, config: { token: "xoxp-x", notifyOnSettle: true } }), {
		now: () => now,
		setTimer: (fn, ms) => {
			const t = { fn, at: now + ms, done: false };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			if (t) t.done = true;
		},
	});
	const flush = async () => {
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	};
	const advance = async (ms) => {
		now += ms;
		for (const t of timers) {
			if (!t.done && t.at <= now) {
				t.done = true;
				t.fn();
			}
		}
		await flush();
	};
	const posts = () => calls.filter((c) => c.method === "chat.postMessage" && c.params.thread_ts).map((c) => c.params.text);
	const records = (kind) => state.entries.filter((e) => e.data?.kind === kind).map((e) => e.data);
	return { bridge, state, calls, flush, advance, posts, records };
}

describe("SlackBridge", () => {
	it("opens a thread in the self DM and records the binding", async () => {
		const h = harness();
		await h.bridge.on();
		await h.flush();
		const open = h.calls.find((c) => c.method === "conversations.open");
		assert.equal(open.params.users, "U1");
		const header = h.calls.find((c) => c.method === "chat.postMessage");
		assert.match(header.params.text, /\*pi: My session\*/);
		assert.equal(header.params.metadata.event_type, METADATA_EVENT);
		assert.deepEqual(h.records("bind"), [{ kind: "bind", sessionId: "s1", channel: "D1", threadTs: "200.000000", userId: "U1" }]);
	});

	it("mirrors local turns and streams the assistant reply with throttled edits", async () => {
		const h = harness();
		await h.bridge.on();
		h.bridge.onInput("interactive");
		h.bridge.onUserMessage({ role: "user", content: "fix **it**" });
		h.bridge.onAgentStart();
		h.bridge.onAssistantUpdate({ content: [{ type: "text", text: "Looking" }] });
		await h.advance(0);
		h.bridge.onToolStart("bash", false);
		h.bridge.onAssistantUpdate({ content: [{ type: "text", text: "Looking at it" }] });
		await h.advance(100);
		assert.equal(h.calls.filter((c) => c.method === "chat.update" && c.params.ts !== "200.000000").length, 0, "throttled");
		await h.advance(3_000);
		h.bridge.onAssistantEnd({ content: [{ type: "text", text: "Done. See `x`." }, { type: "toolCall" }] });
		h.bridge.onSettled();
		await h.flush();

		const posts = h.posts();
		assert.equal(posts[0], "*you, in the terminal*\nfix *it*");
		assert.equal(posts[1], "*pi*\nLooking\n_working_");
		const edits = h.calls.filter((c) => c.method === "chat.update" && c.params.ts === "202.000000").map((c) => c.params.text);
		assert.deepEqual(edits, ["*pi*\nLooking at it\n_working: running `bash`_", "*pi*\nDone. See `x`."]);
		assert.deepEqual(h.records("post").map((r) => r.role), ["user", "assistant"]);

		const notice = h.calls.find((c) => c.method === "chat.postMessage" && !c.params.thread_ts && /finished/.test(c.params.text));
		assert.match(notice.params.text, /<https:\/\/slack\/p1\|open thread>/);
		assert.equal(h.records("notice").length, 1);
		const header = h.calls.filter((c) => c.method === "chat.update" && c.params.ts === "200.000000").map((c) => c.params.text);
		assert.match(header.at(-1), /status: \*idle\*/);
	});

	it("delivers thread replies, reacts, and does not echo them back", async () => {
		const h = harness();
		await h.bridge.on();
		h.state.replies.push({ ts: "500.000000", user: "U1", text: "please run &lt;tests&gt;" }, { ts: "501.000000", user: "U1", text: "and lint" });
		await h.bridge.poll();
		await h.flush();
		assert.deepEqual(h.state.sent, [{ text: "please run <tests>", deliverAs: undefined }]);
		assert.deepEqual(h.records("inbound").map((r) => r.ts), ["500.000000"]);
		assert.ok(h.calls.some((c) => c.method === "reactions.add" && c.params.timestamp === "500.000000" && c.params.name === "white_check_mark"));

		// The injected turn arrives as a user message: not posted again.
		h.bridge.onUserMessage({ role: "user", content: "please run <tests>" });
		h.bridge.onAgentStart();
		h.state.idle = false;
		await h.bridge.poll();
		assert.deepEqual(h.state.sent[1], { text: "and lint", deliverAs: "followUp" });
		h.bridge.onUserMessage({ role: "user", content: [{ type: "text", text: "and lint" }] });
		await h.flush();
		assert.equal(h.posts().length, 0);

		// Polling again never re-delivers.
		await h.bridge.poll();
		assert.equal(h.state.sent.length, 2);
	});

	it("holds replies while the terminal has a draft or a dialog", async () => {
		const h = harness({ editor: "half typed" });
		await h.bridge.on();
		h.state.replies.push({ ts: "500.0", user: "U1", text: "go" });
		await h.bridge.poll();
		await h.flush();
		assert.equal(h.state.sent.length, 0);
		assert.ok(h.state.notes.some((n) => /Send or clear your draft/.test(n.message)));
		assert.match(h.calls.filter((c) => c.method === "chat.update").at(-1).params.text, /reply held/);

		h.state.editor = "";
		h.bridge.onPrompt(true);
		await h.bridge.poll();
		assert.equal(h.state.sent.length, 0);
		h.bridge.onPrompt(false);
		assert.deepEqual(h.state.sent, [{ text: "go", deliverAs: undefined }]);
	});

	it("resumes the thread on reload but keeps /slack off persistent", async () => {
		const h = harness();
		await h.bridge.on();
		h.bridge.onUserMessage({ role: "user", content: "hi" });
		await h.flush();

		const resumed = harness({ entries: h.state.entries });
		resumed.bridge.load("resume");
		await resumed.flush();
		assert.match(resumed.bridge.describeStatus(), /mirroring: on/);
		assert.match(resumed.bridge.describeStatus(), /posted messages: 1/);

		await resumed.bridge.off();
		const again = harness({ entries: resumed.state.entries });
		again.bridge.load("resume");
		assert.match(again.bridge.describeStatus(), /mirroring: off/);
		await again.bridge.on();
		assert.equal(again.records("bind").at(-1).threadTs, "200.000000", "same thread");
		assert.ok(!again.calls.some((c) => c.method === "conversations.open"));
	});

	it("starts a fork unbound and gives it a new thread on /slack on", async () => {
		const parent = harness({ sessionId: "parent" });
		await parent.bridge.on();
		const fork = harness({ sessionId: "fork", entries: parent.state.entries });
		fork.bridge.load("fork");
		assert.match(fork.bridge.describeStatus(), /Not mirrored/);
		assert.ok(fork.state.notes.some((n) => /own thread/.test(n.message)));
		fork.bridge.onUserMessage({ role: "user", content: "hello" });
		await fork.flush();
		assert.equal(fork.calls.length, 0);

		await fork.bridge.on();
		const bind = fork.records("bind").find((r) => r.sessionId === "fork");
		assert.equal(bind.threadTs, "200.000000");
		assert.ok(fork.calls.some((c) => c.method === "conversations.open"));
	});

	it("splits long replies into numbered parts", async () => {
		const h = harness();
		await h.bridge.on();
		const long = Array.from({ length: 40 }, (_v, i) => `Paragraph ${i} ${"word ".repeat(80)}`).join("\n\n");
		h.bridge.onAssistantEnd({ content: [{ type: "text", text: long }] });
		h.bridge.onSettled();
		await h.flush();
		const parts = h.posts();
		assert.ok(parts.length >= 2);
		assert.match(parts[0], /^\*pi\* _part 1\/\d+_/);
		assert.match(parts[1], /^_part 2\/\d+_/);
		assert.ok(parts.every((p) => p.length < 13_000));
	});

	it("stops on an auth error", async () => {
		const h = harness();
		await h.bridge.on();
		h.bridge.reportError?.(new SlackError("chat.postMessage", "invalid_auth"));
		assert.ok(h.state.notes.some((n) => /rejected the token/.test(n.message)));
		assert.match(h.bridge.describeStatus(), /rejected the token/);
	});
});

describe("extension entry point", () => {
	it("registers the command and the events it relies on", () => {
		const events = [];
		const commands = [];
		const pi = {
			on: (name) => events.push(name),
			registerCommand: (name, options) => commands.push({ name, options }),
			appendEntry: () => {},
			sendUserMessage: () => {},
			getSessionName: () => undefined,
		};
		jiti("./extensions/slack-bridge/index.ts").default(pi);
		assert.deepEqual(commands.map((c) => c.name), ["slack"]);
		for (const name of ["session_start", "session_shutdown", "input", "agent_start", "agent_settled", "message_update", "message_end", "tool_execution_start", "ui_prompt_start", "ui_prompt_end", "session_tree"]) {
			assert.ok(events.includes(name), `missing ${name}`);
		}
		assert.deepEqual(commands[0].options.getArgumentCompletions("o").map((i) => i.value), ["on", "on new", "off"]);
	});
});

const auth = jiti("./extensions/slack-bridge/auth.ts");
const TOKEN = "xoxc-1111111111-2222222222-3333333333-abcdef";
const COOKIE = "xoxd-AbC%2FdEf%2BgHi%3D%3Djklmnopqrstu";

describe("credential rotation", () => {
	it("extracts the token and d cookie from browser curl commands", () => {
		const chrome = [
			"curl 'https://example.slack.com/api/conversations.history?_x_id=1' \\",
			"  -H 'accept: */*' \\",
			`  -b 'b=abc; x=1; d=${COOKIE}; d-s=1700000000; lc=1' \\`,
			`  --data-raw $'------WebKitFormBoundary\\r\\nContent-Disposition: form-data; name="token"\\r\\n\\r\\n${TOKEN}\\r\\n------WebKitFormBoundary--\\r\\n'`,
		].join("\n");
		assert.deepEqual(auth.extractAuthFromCurl(chrome), [{ token: TOKEN, cookie: COOKIE }]);

		const firefox = `curl 'https://edgeapi.slack.com/cache/T1/users/info' -H 'Cookie: b=abc; d=${COOKIE}' --data-raw '{"token":"${TOKEN}"}'`;
		assert.deepEqual(auth.extractAuthFromCurl(firefox), [{ token: TOKEN, cookie: COOKIE }]);

		assert.deepEqual(auth.extractAuthFromCurl(`${auth.CURL_INSTRUCTIONS}${TOKEN}\n${COOKIE}`), [{ token: TOKEN, cookie: COOKIE }]);
		assert.throws(() => auth.extractAuthFromCurl(`curl -b 'd=${COOKIE}'`), /No xoxc- token/);
		assert.throws(() => auth.extractAuthFromCurl(`curl --data token=${TOKEN}`), /No d cookie/);
	});

	it("keeps the first pair that auth.test accepts", async () => {
		const tried = [];
		const verified = await auth.verifyCredentials(
			[
				{ token: "xoxc-old", cookie: COOKIE },
				{ token: TOKEN, cookie: COOKIE },
			],
			(c) => ({
				call: async () => {
					tried.push(c.token);
					if (c.token === "xoxc-old") throw new SlackError("auth.test", "invalid_auth");
					return { ok: true, user: "me", team: "Acme" };
				},
			}),
		);
		assert.deepEqual(tried, ["xoxc-old", TOKEN]);
		assert.equal(verified.user, "me");
		await assert.rejects(
			auth.verifyCredentials([{ token: TOKEN, cookie: COOKIE }], () => ({ call: async () => Promise.reject(new SlackError("auth.test", "token_revoked")) })),
			/token_revoked/,
		);
	});

	it("saves into the config privately and keeps other settings", async () => {
		const dir = mkdtempSync(join(tmpdir(), "slack-bridge-auth-"));
		const path = join(dir, "nested", "config.json");
		const editorCalls = [];
		const saved = await auth.runAuthFlow({
			path,
			editor: async (title, prefill) => {
				editorCalls.push({ title, prefill });
				return `${prefill}curl -b 'd=${COOKIE}' --data 'token=${TOKEN}'`;
			},
			makeClient: () => ({ call: async () => ({ ok: true, user: "me", team: "Acme" }) }),
		});
		assert.equal(saved.team, "Acme");
		assert.match(editorCalls[0].prefill, /Copy as cURL/);
		const config = loadConfig(path);
		assert.equal(config.token, TOKEN);
		assert.equal(config.cookie, COOKIE);

		writeFileSync(path, JSON.stringify({ token: "xoxp-old", notifyOnSettle: false, channel: "D9" }), { mode: 0o644 });
		auth.saveCredentials(path, { token: TOKEN, cookie: COOKIE });
		const rotated = loadConfig(path); // would throw if the file were not 0600
		assert.deepEqual([rotated.token, rotated.notifyOnSettle, rotated.channel], [TOKEN, false, "D9"]);

		const cancelled = await auth.runAuthFlow({ path, editor: async (_t, prefill) => prefill });
		assert.equal(cancelled, undefined);
	});

	it("resumes mirroring after an auth error once credentials are saved", async () => {
		const h = harness();
		await h.bridge.on();
		h.bridge.reportError(new SlackError("conversations.replies", "token_expired"));
		assert.equal(h.bridge.needsAuth(), true);
		assert.match(h.bridge.describeStatus(), /run \/slack auth/);
		assert.ok(h.state.notes.some((n) => /\/slack auth/.test(n.message)));

		h.state.replies.push({ ts: "600.0", user: "U1", text: "still there?" });
		assert.match(h.bridge.reconnect(), /Mirroring resumed/);
		assert.equal(h.bridge.needsAuth(), false);
		await h.advance(0);
		assert.deepEqual(h.state.sent.map((s) => s.text), ["still there?"]);
	});
});

describe("/slack command sign-in", () => {
	function command({ editorText, failFirst }) {
		const dir = mkdtempSync(join(tmpdir(), "slack-bridge-cmd-"));
		process.env.PI_SLACK_BRIDGE_CONFIG = join(dir, "config.json");
		const notes = [];
		const confirms = [];
		let handler;
		const pi = {
			on: () => {},
			registerCommand: (_name, options) => (handler = options.handler),
			appendEntry: () => {},
			sendUserMessage: () => {},
			getSessionName: () => undefined,
		};
		jiti("./extensions/slack-bridge/index.ts").default(pi);
		const entries = [];
		const ctx = {
			hasUI: true,
			cwd: "/repo",
			isIdle: () => true,
			sessionManager: { getSessionId: () => "s1", getEntries: () => entries },
			ui: {
				notify: (message, level) => notes.push({ message, level }),
				setStatus: () => {},
				getEditorText: () => "",
				confirm: async (title, message) => (confirms.push({ title, message }), true),
				editor: async (_title, prefill) => `${prefill}${editorText}`,
			},
		};
		const calls = [];
		globalThis.fetch = async (url, init) => {
			const method = url.split("/").pop();
			const token = new URLSearchParams(init.body).get("token");
			calls.push({ method, token });
			const ok = (data) => ({ status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ...data }) });
			if (method === "auth.test" && failFirst && token === "xoxc-expired-000000000000000") return { status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: "invalid_auth" }) };
			if (method === "auth.test") return ok({ user: "me", team: "Acme", user_id: "U1" });
			if (method === "conversations.open") return ok({ channel: { id: "D1" } });
			if (method === "chat.postMessage") return ok({ ts: "700.000000" });
			return ok({ messages: [] });
		};
		return { run: (args) => handler(args, ctx), notes, confirms, calls, path: process.env.PI_SLACK_BRIDGE_CONFIG };
	}

	it("offers the curl prompt when no config exists, then turns mirroring on", async () => {
		const c = command({ editorText: `curl -b 'd=${COOKIE}' --data 'token=${TOKEN}'` });
		await c.run("on");
		assert.match(c.confirms[0].message, /No config/);
		assert.ok(c.notes.some((n) => /Signed in to Slack as me \(Acme\)/.test(n.message)));
		assert.ok(c.notes.some((n) => /Mirroring this session/.test(n.message)));
		assert.equal(loadConfig(c.path).token, TOKEN);
		assert.ok(c.calls.some((x) => x.method === "chat.postMessage" && x.token === TOKEN));
		assert.ok(!c.notes.some((n) => n.message.includes(TOKEN)), "token never shown");
	});

	it("offers the curl prompt when the saved token is rejected", async () => {
		const c = command({ editorText: `curl -b 'd=${COOKIE}' --data 'token=${TOKEN}'`, failFirst: true });
		writeFileSync(c.path, JSON.stringify({ token: "xoxc-expired-000000000000000", cookie: COOKIE }), { mode: 0o600 });
		await c.run("on");
		assert.match(c.confirms[0].message, /rejected the saved token/);
		assert.equal(loadConfig(c.path).token, TOKEN);
		assert.ok(c.notes.some((n) => /Mirroring this session/.test(n.message)));
	});

	it("/slack auth rotates credentials directly", async () => {
		const c = command({ editorText: `curl -b 'd=${COOKIE}' --data 'token=${TOKEN}'` });
		await c.run("auth");
		assert.equal(c.confirms.length, 0);
		assert.ok(c.notes.some((n) => /Run \/slack on to start/.test(n.message)));
		delete process.env.PI_SLACK_BRIDGE_CONFIG;
	});
});
