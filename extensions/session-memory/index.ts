/**
 * Session Memory — converts pi session JSONL files into readable markdown.
 *
 * Automatically converts the current session on each agent turn (debounced).
 * Flushes on session shutdown and session switch.
 *
 * Commands:
 *   /session-memory backfill  — convert all existing sessions in this profile
 *   /session-memory debug     — toggle debug notifications
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, interactiveSetup, getSessionsDir } from "./lib/config";
import { convertSession, generateMOC } from "./lib/jsonl-to-md";
import type { SessionMemoryConfig } from "./lib/types";

const DEBOUNCE_MS = 2000;

export default function (pi: ExtensionAPI) {
	let config: SessionMemoryConfig | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let debug = false;

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx);
		if (!config) {
			config = await interactiveSetup(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!config) return;
		scheduleConvert(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!config) return;
		cancelDebounce();
		flushCurrentSession(ctx);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		if (!config) return;
		cancelDebounce();
		flushCurrentSession(ctx);
	});

	pi.registerCommand("session-memory", {
		description: "Session memory management (backfill | debug)",
		handler: async (args, ctx) => {
			if (!config) {
				config = await interactiveSetup(ctx);
				if (!config) {
					ctx.ui.notify("Session memory not configured", "warning");
					return;
				}
			}

			const subcommand = args?.trim();

			if (subcommand === "backfill") {
				await runBackfill(ctx);
			} else if (subcommand === "debug") {
				debug = !debug;
				ctx.ui.notify(`session-memory debug ${debug ? "on" : "off"}`, "info");
			} else {
				ctx.ui.notify("Usage: /session-memory backfill | debug", "info");
			}
		},
	});

	// ── Internal helpers ─────────────────────────────────────────────────────

	function scheduleConvert(ctx: ExtensionContext) {
		cancelDebounce();
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			flushCurrentSession(ctx);
		}, DEBOUNCE_MS);
	}

	function cancelDebounce() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function flushCurrentSession(ctx: ExtensionContext) {
		if (!config) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		if (!existsSync(sessionFile)) return;

		try {
			const result = convertSession(sessionFile, config);
			if (result.isNewSession || result.written > 0) generateMOC(config);
			if (debug && result.written > 0) {
				ctx.ui.notify(
					`📝 ${result.sessionDir}: ${result.written} written, ${result.skipped} skipped`,
					"info",
				);
			}
		} catch (err) {
			console.error("[session-memory] flush error:", err);
		}
	}

	async function runBackfill(ctx: Parameters<Parameters<typeof pi.registerCommand>[1]["handler"]>[1]) {
		if (!config) return;

		const sessionsRoot = getSessionsDir(ctx);
		ctx.ui.setStatus("session-memory", "⏳ Scanning sessions...");
		await tick();
		const jsonlFiles = findJsonlFiles(sessionsRoot);
		ctx.ui.setStatus("session-memory", "");

		if (jsonlFiles.length === 0) {
			ctx.ui.notify("No session files found", "info");
			return;
		}

		const proceed = await ctx.ui.confirm(
			"Backfill",
			`Convert ${jsonlFiles.length} session files to markdown?`,
		);
		if (!proceed) return;

		ctx.ui.setStatus("session-memory", "⏳ Converting sessions...");
		await tick();
		let total = 0;
		let errors = 0;

		for (const file of jsonlFiles) {
			try {
				const result = convertSession(file, config);
				total += result.written;
			} catch (err) {
				errors++;
				console.error(`[session-memory] backfill error for ${file}:`, err);
			}
		}

		generateMOC(config);

		ctx.ui.setStatus("session-memory", "");

		const msg = errors > 0
			? `Backfill done: ${total} segments written, ${errors} errors`
			: `Backfill done: ${total} segments written from ${jsonlFiles.length} sessions`;
		ctx.ui.notify(msg, errors > 0 ? "warning" : "success");
	}
}

/** Recursively find all .jsonl files under a directory. */
function findJsonlFiles(dir: string): string[] {
	const results: string[] = [];
	try {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					results.push(...findJsonlFiles(full));
				} else if (entry.endsWith(".jsonl")) {
					results.push(full);
				}
			} catch {
				// skip unreadable entries
			}
		}
	} catch {
		// skip unreadable directories
	}
	return results;
}

/** Yield to the event loop so the UI can render. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}