/** Slack Web API client and config loading for the bridge. */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
	/** `xoxp-` user token, or `xoxc-` client token (needs `cookie`). */
	token: string;
	/** Value of the Slack `d` cookie (`xoxd-...`). Only for `xoxc-` tokens. */
	cookie?: string;
	/** Post a short top-level DM notice when a turn finishes. Default true. */
	notifyOnSettle?: boolean;
	/** Override the self-DM channel id. Normally discovered with conversations.open. */
	channel?: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_SLACK_BRIDGE_CONFIG || join(homedir(), ".config", "pi-slack-bridge", "config.json");
}

export class ConfigError extends Error {}

export function loadConfig(path = configPath()): BridgeConfig {
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		throw new ConfigError(`No config at ${path}. See the slack-bridge README for how to get a token.`);
	}
	if (process.platform !== "win32" && (mode & 0o077) !== 0) {
		throw new ConfigError(`${path} is readable by other users. Run: chmod 600 ${path}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	const config = parsed as Partial<BridgeConfig>;
	if (typeof config.token !== "string" || !/^xox[pc]-/.test(config.token)) {
		throw new ConfigError(`${path} needs a "token" that starts with xoxp- or xoxc-.`);
	}
	if (config.token.startsWith("xoxc-") && typeof config.cookie !== "string") {
		throw new ConfigError(`${path}: xoxc- tokens also need "cookie" (the xoxd- value of Slack's d cookie).`);
	}
	return {
		token: config.token,
		cookie: config.cookie ? config.cookie.replace(/^d=/, "").replace(/;.*$/, "").trim() : undefined,
		notifyOnSettle: config.notifyOnSettle ?? true,
		channel: typeof config.channel === "string" ? config.channel : undefined,
	};
}

export class SlackError extends Error {
	constructor(
		readonly method: string,
		readonly code: string,
	) {
		super(`Slack ${method} failed: ${code}`);
	}
}

export const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

export function isAuthError(error: unknown): boolean {
	return error instanceof SlackError && AUTH_ERRORS.has(error.code);
}

export type SlackParams = Record<string, string | number | boolean | object | undefined>;

export interface SlackApi {
	call<T = Record<string, unknown>>(method: string, params?: SlackParams): Promise<T>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	json(): Promise<unknown>;
}>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal Web API client. Sends form-encoded requests (works for both user and
 * client tokens) and waits out HTTP 429 responses using Retry-After.
 */
export class SlackClient implements SlackApi {
	private blockedUntil = 0;

	constructor(
		private readonly config: Pick<BridgeConfig, "token" | "cookie">,
		private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
		private readonly maxRetries = 3,
	) {}

	async call<T = Record<string, unknown>>(method: string, params: SlackParams = {}): Promise<T> {
		const body = new URLSearchParams({ token: this.config.token });
		for (const [key, value] of Object.entries(params)) {
			if (value === undefined) continue;
			body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
		}
		const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
		if (this.config.cookie) headers.Cookie = `d=${this.config.cookie}`;

		for (let attempt = 0; ; attempt++) {
			const wait = this.blockedUntil - Date.now();
			if (wait > 0) await sleep(wait);
			const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
				method: "POST",
				headers,
				body: body.toString(),
				signal: AbortSignal.timeout(20_000),
			});
			if (response.status === 429) {
				const seconds = Number(response.headers.get("retry-after") ?? "5");
				this.blockedUntil = Date.now() + (Number.isFinite(seconds) ? seconds : 5) * 1000;
				if (attempt < this.maxRetries) continue;
				throw new SlackError(method, "ratelimited");
			}
			const data = (await response.json()) as { ok?: boolean; error?: string };
			if (!data.ok) throw new SlackError(method, data.error ?? `http_${response.status}`);
			return data as T;
		}
	}
}
