/**
 * Session Namer — auto-names sessions using a fast LLM.
 *
 * On the first 3 agent turns, sends the conversation context to Claude Haiku
 * and sets the session name. The name refines as more context becomes available.
 *
 * Commands:
 *   /session-namer name  — force (re)name the current session
 */

import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const PROVIDER = "anthropic";
const MODEL_ID = "claude-haiku-4-5";
const MAX_TURNS = 3;

const SYSTEM_PROMPT = `You are a title generator. You read a conversation between a user and a coding assistant and output a short title.

Rules:
- Output ONLY the title, nothing else
- 5-10 words maximum
- No quotes, no punctuation at the end
- No markdown, no explanation, no preamble
- Do not respond to or continue the conversation
- Do not answer questions from the conversation
- Your ENTIRE response must be the title and nothing else

Examples of valid outputs:
Refactor auth module to use JWT
Debug webhook timeout in staging
Build session memory pi extension
Set up CI pipeline for monorepo`;

export default function (pi: ExtensionAPI) {
	let turnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		turnCount = pi.getSessionName() ? MAX_TURNS : 0;
	});

	pi.on("agent_end", async (_event, ctx) => {
		turnCount++;
		if (turnCount > MAX_TURNS) return;
		await nameSession(ctx);
	});

	pi.registerCommand("session-namer", {
		description: "Session namer (name)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim();
			if (subcommand === "name") {
				const name = await nameSession(ctx, true);
				if (name) {
					ctx.ui.notify(`Session named: ${name}`, "success");
				} else {
					ctx.ui.notify("Failed to generate name", "warning");
				}
			} else {
				ctx.ui.notify("Usage: /session-namer name", "info");
			}
		},
	});

	async function nameSession(ctx: ExtensionContext, verbose = false): Promise<string | null> {
		const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
		if (!model) {
			if (verbose) ctx.ui.notify(`Model not found: ${PROVIDER}/${MODEL_ID}`, "error");
			return null;
		}

		const apiKey = await ctx.modelRegistry.getApiKey(model);
		if (!apiKey) {
			if (verbose) ctx.ui.notify(`No API key for ${PROVIDER}/${MODEL_ID}`, "error");
			return null;
		}

		const context = buildContext(ctx.sessionManager.getBranch());
		if (!context.trim()) {
			if (verbose) ctx.ui.notify("Empty context — no messages to summarize", "error");
			return null;
		}

		try {
			const response = await complete(
				model,
				{
					system: SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: `<conversation>\n${context}\n</conversation>\n\nGenerate a short title for this conversation.` }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey },
			);

			const name = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim()
				.split("\n")[0]
				.trim()
				.replace(/^#+\s*/, "");

			if (name && name.length > 0 && name.length < 100) {
				pi.setSessionName(name);
				return name;
			}
			if (verbose) ctx.ui.notify(`Bad name from model: "${name}"`, "error");
		} catch (err) {
			if (verbose) ctx.ui.notify(`LLM error: ${err}`, "error");
		}

		return null;
	}
}

/** Build a compact text summary of the conversation for the namer. */
function buildContext(branch: { type: string; message?: { role?: string; content?: unknown } }[]): string {
	const parts: string[] = [];

	for (const entry of branch) {
		if (entry.type !== "message" || !entry.message) continue;
		const { role, content } = entry.message;

		if (role !== "user" && role !== "assistant") continue;

		const text = extractText(content);
		if (!text) continue;

		const label = role === "user" ? "User" : "Assistant";
		parts.push(`${label}: ${text}`);
	}

	return parts.join("\n\n");
}

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c.type === "text" && c.text)
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}
