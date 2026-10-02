/**
 * Credential rotation from inside pi: paste a "Copy as cURL" request from the
 * Slack web client, keep only the xoxc- token and the d cookie, check them with
 * auth.test, and write them to the bridge config.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BridgeConfig, SlackClient, SlackError } from "./slack.ts";

export interface ClientCredentials {
	token: string;
	cookie: string;
}

export const CURL_INSTRUCTIONS = [
	"# Paste a curl command copied from Slack below these lines, then save.",
	"#",
	"# 1. Open your Slack workspace in Chrome, Edge or Firefox and sign in.",
	"# 2. Open the developer tools (Cmd+Option+I or F12) and select the Network tab.",
	"# 3. Do anything in Slack, for example switch channels.",
	"# 4. Right-click a request to slack.com/api/ or edgeapi.slack.com and choose Copy as cURL.",
	"#",
	"# Only the xoxc- token and the d cookie are kept. The rest of the command is discarded.",
	"",
	"",
].join("\n");

/**
 * Pull xoxc- tokens and xoxd- cookies out of a pasted curl command (or bare
 * values). Returns every token/cookie pair, most likely first.
 */
export function extractAuthFromCurl(text: string): ClientCredentials[] {
	const body = text
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n");
	const unique = (values: string[]) => [...new Set(values)];
	const tokens = unique([...body.matchAll(/xoxc-[A-Za-z0-9-]{20,}/g)].map((m) => m[0]));
	let cookies = unique([...body.matchAll(/(?:^|[\s;'"$])d=(xoxd-[^;"'\s&)}]+)/g)].map((m) => m[1]));
	if (!cookies.length) cookies = unique([...body.matchAll(/xoxd-[A-Za-z0-9%/+=_-]{20,}/g)].map((m) => m[0]));
	if (!tokens.length) throw new Error("No xoxc- token found. Copy a request to slack.com/api/ or edgeapi.slack.com.");
	if (!cookies.length) throw new Error("No d cookie (xoxd-...) found. Copy the request as cURL so the cookies are included.");
	return tokens.flatMap((token) => cookies.map((cookie) => ({ token, cookie })));
}

export interface VerifiedCredentials extends ClientCredentials {
	user: string;
	team: string;
}

type ClientFactory = (credentials: ClientCredentials) => Pick<SlackClient, "call">;

/** Return the first pair that auth.test accepts. */
export async function verifyCredentials(
	candidates: ClientCredentials[],
	makeClient: ClientFactory = (credentials) => new SlackClient(credentials),
): Promise<VerifiedCredentials> {
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			const res = await makeClient(candidate).call<{ user?: string; team?: string }>("auth.test");
			return { ...candidate, user: res.user ?? "unknown", team: res.team ?? "unknown" };
		} catch (error) {
			errors.push(error instanceof SlackError ? error.code : (error as Error).message);
		}
	}
	throw new Error(`Slack rejected the pasted credentials (${[...new Set(errors)].join(", ")}). Copy a fresh request and try again.`);
}

/**
 * Write the token and cookie into the config file, keeping its other fields.
 * The file is replaced atomically and is only readable by you.
 */
export function saveCredentials(path: string, credentials: ClientCredentials): void {
	let existing: Partial<BridgeConfig> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object") existing = parsed;
	} catch {
		// Missing or unreadable: start fresh.
	}
	const next: BridgeConfig = { ...existing, token: credentials.token, cookie: credentials.cookie };
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export interface AuthFlowDeps {
	editor(title: string, prefill: string): Promise<string | undefined>;
	path: string;
	makeClient?: ClientFactory;
}

/** Ask for a curl command, verify it, and save it. Returns undefined if cancelled. */
export async function runAuthFlow(deps: AuthFlowDeps): Promise<VerifiedCredentials | undefined> {
	const pasted = await deps.editor("Slack: paste a curl command from your browser", CURL_INSTRUCTIONS);
	if (!pasted || !pasted.split("\n").some((line) => line.trim() && !line.startsWith("#"))) return undefined;
	const verified = await verifyCredentials(extractAuthFromCurl(pasted), deps.makeClient);
	saveCredentials(deps.path, verified);
	return verified;
}
