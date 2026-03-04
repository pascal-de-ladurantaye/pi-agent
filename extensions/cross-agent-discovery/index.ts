/**
 * Cross-Agent Discovery — discovers project-local Claude slash commands as pi prompt templates.
 *
 * Scans `.claude/commands/` in the project root for `.md` files and registers them
 * as pi prompt templates via `resources_discover`. Claude's `$ARGUMENTS` placeholder
 * is natively supported by pi.
 *
 * Commands:
 *   /cross-agent-discovery  — list discovered commands
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	function discoverClaudeCommands(cwd: string): string[] {
		const commandsDir = join(cwd, ".claude", "commands");
		if (!existsSync(commandsDir)) return [];

		const paths: string[] = [];
		try {
			for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
				if (!entry.name.endsWith(".md")) continue;

				const fullPath = join(commandsDir, entry.name);
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(fullPath).isFile();
					} catch {
						continue;
					}
				}
				if (isFile) paths.push(fullPath);
			}
		} catch {
			// Directory not readable — skip silently
		}
		return paths;
	}

	pi.on("resources_discover", (_event, ctx) => {
		const paths = discoverClaudeCommands(ctx.cwd);
		if (paths.length === 0) return {};
		return { promptPaths: paths };
	});

	pi.registerCommand("cross-agent-discovery", {
		description: "List discovered Claude commands",
		handler: async (_args, ctx) => {
			const paths = discoverClaudeCommands(ctx.cwd);
			if (paths.length === 0) {
				ctx.ui.notify("No .claude/commands/ found in this project", "info");
			} else {
				const names = paths.map((p) => `/${p.split("/").pop()!.replace(/\.md$/, "")}`);
				ctx.ui.notify(`${paths.length} Claude command(s): ${names.join(", ")}`, "info");
			}
		},
	});
}
