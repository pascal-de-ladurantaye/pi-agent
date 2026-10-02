/**
 * Slack bridge: mirror an opted-in pi session to a thread in your Slack DM with
 * yourself, and reply in that thread to send the agent a new turn.
 *
 * Commands:
 *   /slack on       start (or continue) mirroring this session
 *   /slack on new   start a fresh thread
 *   /slack off      stop mirroring; persisted in the session tree
 *   /slack status   show the binding and poll state
 *   /slack auth     paste a curl command from the Slack web client to save fresh credentials
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { runAuthFlow } from "./auth.ts";
import { type BridgeHost, SlackBridge } from "./bridge.ts";
import { ConfigError, SlackClient, configPath, isAuthError, loadConfig } from "./slack.ts";
import { ENTRY_TYPE } from "./state.ts";

export default function slackBridge(pi: ExtensionAPI) {
	let bridge: SlackBridge | undefined;
	let ctxRef: ExtensionContext | undefined;

	const host: BridgeHost = {
		sessionId: () => ctxRef!.sessionManager.getSessionId(),
		entries: () => ctxRef!.sessionManager.getEntries(),
		append: (record) => pi.appendEntry(ENTRY_TYPE, record),
		sendUserMessage: (text, deliverAs) => (deliverAs ? pi.sendUserMessage(text, { deliverAs }) : pi.sendUserMessage(text)),
		isIdle: () => ctxRef?.isIdle() ?? true,
		editorText: () => (ctxRef?.hasUI ? (ctxRef.ui.getEditorText() ?? "") : ""),
		notify: (message, level) => ctxRef?.hasUI && ctxRef.ui.notify(message, level),
		setStatus: (text) => ctxRef?.hasUI && ctxRef.ui.setStatus("slack-bridge", text),
		describe: () => ({ cwd: ctxRef?.cwd ?? process.cwd(), name: pi.getSessionName(), model: ctxRef?.model?.id }),
	};

	const loadApi = () => {
		const config = loadConfig();
		return { api: new SlackClient(config), config };
	};

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		bridge = new SlackBridge(host, loadApi);
		// Only interactive sessions take replies from Slack.
		if (ctx.hasUI) bridge.load(event.reason);
	});

	pi.on("session_shutdown", async (event) => {
		await bridge?.shutdown(event.reason);
		bridge = undefined;
	});

	pi.on("input", async (event) => {
		bridge?.onInput(event.source);
		return { action: "continue" as const };
	});

	pi.on("agent_start", async () => bridge?.onAgentStart());
	pi.on("agent_settled", async () => bridge?.onSettled());

	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant") bridge?.onAssistantUpdate(event.message);
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
		if (message.role === "user") bridge?.onUserMessage(message);
		else if (message.role === "assistant") bridge?.onAssistantEnd(message);
	});

	pi.on("tool_execution_start", async (event) => bridge?.onToolStart(event.toolName, !!event.parentToolCallId));
	pi.on("tool_execution_end", async (event) => bridge?.onToolEnd(!!event.parentToolCallId));
	pi.on("ui_prompt_start", async () => bridge?.onPrompt(true));
	pi.on("ui_prompt_end", async () => bridge?.onPrompt(false));
	pi.on("session_tree", async () => bridge?.onTreeNavigated());
	pi.on("session_info_changed", async () => bridge?.onSessionInfoChanged());

	/** Ask for a curl command and save the credentials. Returns true when saved. */
	const authenticate = async (ctx: ExtensionCommandContext): Promise<boolean> => {
		const path = configPath();
		const verified = await runAuthFlow({ editor: (title, prefill) => ctx.ui.editor(title, prefill), path });
		if (!verified) {
			ctx.ui.notify("Slack sign-in cancelled.", "info");
			return false;
		}
		ctx.ui.notify(`Signed in to Slack as ${verified.user} (${verified.team}). Saved to ${path}.`, "info");
		return true;
	};

	const turnOn = async (ctx: ExtensionCommandContext, forceNew: boolean) => {
		try {
			ctx.ui.notify(await bridge!.on(forceNew), "info");
		} catch (error) {
			if (!(error instanceof ConfigError || isAuthError(error))) throw error;
			const why = error instanceof ConfigError ? error.message : `Slack rejected the saved token (${(error as Error).message}).`;
			if (!(await ctx.ui.confirm("Slack sign-in needed", `${why}\n\nPaste a curl command from your browser now?`))) return;
			if (!(await authenticate(ctx))) return;
			ctx.ui.notify(await bridge!.on(forceNew), "info");
		}
	};

	pi.registerCommand("slack", {
		description: "Mirror this session to Slack (on [new] | off | status | auth)",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "on new", "off", "status", "auth"].filter((item) => item.startsWith(prefix.trim()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			ctxRef = ctx;
			bridge ??= new SlackBridge(host, loadApi);
			const [sub = "status", flag] = (args ?? "").trim().split(/\s+/);
			try {
				if (sub === "on") await turnOn(ctx, flag === "new");
				else if (sub === "off") ctx.ui.notify(await bridge.off(), "info");
				else if (sub === "status") ctx.ui.notify(bridge.describeStatus(), "info");
				else if (sub === "auth") {
					if (await authenticate(ctx)) ctx.ui.notify(bridge.reconnect(), "info");
				} else ctx.ui.notify("Usage: /slack on [new] | off | status | auth", "warning");
			} catch (error) {
				ctx.ui.notify(`Slack bridge: ${(error as Error).message}`, "error");
			}
		},
	});
}
