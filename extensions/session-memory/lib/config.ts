import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SessionMemoryConfig } from "./types";

const CONFIG_FILENAME = "session-memory.json";

const DEFAULT_VAULT_PATH = join(homedir(), "vault", "work", "pi-sessions");

/**
 * Derive the pi profile directory from the current session.
 * sessionDir is like ~/.pi/agent-shopify/sessions/--encoded-cwd--/
 * We go up past the encoded-cwd dir and the "sessions" dir.
 */
export function getProfileDir(ctx: ExtensionContext): string {
	const sessionDir = ctx.sessionManager.getSessionDir();
	return resolve(sessionDir, "..", "..");
}

/** Root sessions directory for this profile. */
export function getSessionsDir(ctx: ExtensionContext): string {
	return join(getProfileDir(ctx), "sessions");
}

/** Path to the config file for this profile. */
export function getConfigPath(ctx: ExtensionContext): string {
	return join(getProfileDir(ctx), CONFIG_FILENAME);
}

/** Load config, returns null if missing or invalid. */
export function loadConfig(ctx: ExtensionContext): SessionMemoryConfig | null {
	const configPath = getConfigPath(ctx);
	if (!existsSync(configPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"));
		if (!raw.vaultPath || typeof raw.vaultPath !== "string") return null;
		return { vaultPath: expandHome(raw.vaultPath) };
	} catch {
		return null;
	}
}

/** Save config to the profile directory. */
export function saveConfig(ctx: ExtensionContext, config: SessionMemoryConfig): void {
	const configPath = getConfigPath(ctx);
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** Interactive first-run setup. Returns config if user completes it, null if cancelled. */
export async function interactiveSetup(ctx: ExtensionContext): Promise<SessionMemoryConfig | null> {
	const wantSetup = await ctx.ui.confirm("Session Memory", "No config found. Set up now?");
	if (!wantSetup) return null;

	const vaultPath = await ctx.ui.input("Vault Path", "Where to write session markdown?", {
		default: DEFAULT_VAULT_PATH,
	});
	if (!vaultPath) return null;

	const config: SessionMemoryConfig = { vaultPath: expandHome(vaultPath) };
	saveConfig(ctx, config);
	ctx.ui.notify(`Config saved to ${getConfigPath(ctx)}`, "success");
	return config;
}

function expandHome(p: string): string {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
