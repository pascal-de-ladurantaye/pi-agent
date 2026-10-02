/**
 * Markdown <-> Slack mrkdwn conversion.
 *
 * Slack does not render CommonMark. It uses its own "mrkdwn": single `*` for
 * bold, `_` for italic, `~` for strike, `<url|text>` links, no headings and no
 * tables. `&`, `<` and `>` are control characters and must be escaped everywhere,
 * including inside code.
 */

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Escape Slack control characters. */
export function escapeSlack(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanUrl(url: string): string {
	return url.trim().replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/** Convert inline markdown (one line, outside code blocks) to mrkdwn. */
export function convertInline(line: string): string {
	const slots: string[] = [];
	const hold = (value: string) => `\u0000${slots.push(value) - 1}\u0000`;

	let s = line;
	// Inline code spans, any backtick run length.
	s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, body: string) => hold("`" + escapeSlack(body.trim() || body) + "`"));
	// Images, then links, then bare autolinks.
	s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, url: string) =>
		hold(`<${cleanUrl(url)}|${escapeSlack(alt || "image")}>`),
	);
	s = s.replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, text: string, url: string) =>
		hold(`<${cleanUrl(url)}|${escapeSlack(stripEmphasis(text))}>`),
	);
	s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => hold(`<${cleanUrl(url)}>`));

	s = escapeSlack(s);

	// Bold (and bold-italic) first, held behind markers so the italic pass skips them.
	const B = "\u0001";
	s = s.replace(/\*\*\*(?=\S)([^*]+?)(?<=\S)\*\*\*/g, `${B}_$1_${B}`);
	s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${B}$1${B}`);
	s = s.replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, `$1${B}$2${B}`);
	// Single-asterisk italic. Underscore italic is already Slack syntax.
	s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, "$1_$2_");
	s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~");
	s = s.replaceAll(B, "*");

	return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

function stripEmphasis(text: string): string {
	return text.replace(/\*\*|__|~~|`/g, "");
}

function splitRow(row: string): string[] {
	let r = row.trim();
	if (r.startsWith("|")) r = r.slice(1);
	if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
	return r.split(/(?<!\\)\|/).map((cell) => stripEmphasis(cell.replace(/\\\|/g, "|").trim()));
}

function renderTable(rows: string[]): string[] {
	const cells = rows.filter((_r, i) => i !== 1).map(splitRow);
	const width = Math.max(...cells.map((c) => c.length));
	const sizes = Array.from({ length: width }, (_v, col) => Math.max(...cells.map((c) => (c[col] ?? "").length)));
	const fmt = (c: string[]) => sizes.map((size, col) => (c[col] ?? "").padEnd(size)).join("  ").trimEnd();
	const lines = [fmt(cells[0]), sizes.map((size) => "-".repeat(size)).join("  "), ...cells.slice(1).map(fmt)];
	return ["```", ...lines.map(escapeSlack), "```"];
}

/**
 * Convert a markdown document to Slack mrkdwn. An unclosed code fence (common
 * while a reply is still streaming) is closed at the end.
 */
export function toMrkdwn(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let fence: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fenceMatch = line.match(FENCE_RE);

		if (fence !== undefined) {
			if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !fenceMatch[2]) {
				out.push("```");
				fence = undefined;
			} else {
				out.push(escapeSlack(line));
			}
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			out.push("```");
			continue;
		}

		if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
			const rows = [line, lines[i + 1]];
			let j = i + 2;
			while (j < lines.length && TABLE_ROW_RE.test(lines[j])) rows.push(lines[j++]);
			out.push(...renderTable(rows));
			i = j - 1;
			continue;
		}

		const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
		if (heading) {
			out.push(`*${convertInline(stripEmphasis(heading[1]))}*`);
			continue;
		}
		if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push("──────────");
			continue;
		}

		const quote = line.match(/^(\s*(?:>\s?)+)(.*)$/);
		if (quote) {
			out.push(`> ${convertBlockLine(quote[2])}`);
			continue;
		}
		out.push(convertBlockLine(line));
	}

	if (fence !== undefined) out.push("```");
	return out.join("\n");
}

function convertBlockLine(line: string): string {
	const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
	if (task) return `${indent(task[1])}${task[2] === " " ? "☐" : "☑"} ${convertInline(task[3])}`;
	const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
	if (bullet) {
		const level = depth(bullet[1]);
		return `${indent(bullet[1])}${level === 0 ? "•" : "◦"} ${convertInline(bullet[2])}`;
	}
	const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
	if (ordered) return `${indent(ordered[1])}${ordered[2]}. ${convertInline(ordered[3])}`;
	return convertInline(line);
}

function depth(ws: string): number {
	return Math.floor(ws.replace(/\t/g, "    ").length / 2);
}

function indent(ws: string): string {
	return "    ".repeat(depth(ws));
}

/**
 * Split markdown into chunks of at most `limit` characters. Prefers blank-line
 * boundaries outside code, then line boundaries. A chunk that ends inside a code
 * fence is closed and the fence is reopened at the start of the next chunk.
 */
export function splitMarkdown(markdown: string, limit: number): string[] {
	const text = markdown.replace(/\r\n?/g, "\n");
	if (text.length <= limit) return [text];
	const reserve = 8; // room for a closing fence
	const max = Math.max(16, limit - reserve);

	type Line = { text: string; fence: string | undefined }; // fence opener still open after this line
	const chunks: string[] = [];
	let current: Line[] = [];
	let size = 0;
	let fence: string | undefined;

	const closer = (opener: string) => opener.trim().match(/^(`{3,}|~{3,})/)![1];
	const flush = (upto: number) => {
		const body = current.slice(0, upto);
		const open = body.length ? body[body.length - 1].fence : undefined;
		const lines = body.map((l) => l.text);
		while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
		if (open) lines.push(closer(open));
		if (lines.length) chunks.push(lines.join("\n"));
		let rest = current.slice(upto);
		while (rest.length && !rest[0].fence && rest[0].text.trim() === "") rest = rest.slice(1);
		current = open ? [{ text: open, fence: open }, ...rest] : rest;
		size = current.reduce((n, l) => n + l.text.length + 1, 0);
	};

	for (const raw of text.split("\n")) {
		const pieces: string[] = [];
		for (let rest = raw; ; ) {
			if (rest.length <= max) {
				pieces.push(rest);
				break;
			}
			const cut = rest.lastIndexOf(" ", max);
			const at = cut > max / 2 ? cut : max;
			pieces.push(rest.slice(0, at));
			rest = rest.slice(at).replace(/^ /, "");
		}

		for (const piece of pieces) {
			if (current.length && size + piece.length + 1 > max) {
				let at = -1;
				for (let i = current.length - 1; i > 0; i--) {
					if (!current[i].fence && current[i].text.trim() === "" && !FENCE_RE.test(current[i].text)) {
						at = i;
						break;
					}
				}
				const before = at > 0 ? current.slice(0, at).reduce((n, l) => n + l.text.length + 1, 0) : 0;
				flush(at > 0 && before > max / 2 ? at : current.length);
			}
			const m = piece.match(FENCE_RE);
			if (fence === undefined && m) fence = piece;
			else if (fence !== undefined && m && !m[2] && m[1][0] === closer(fence)[0] && m[1].length >= closer(fence).length) fence = undefined;
			current.push({ text: piece, fence });
			size += piece.length + 1;
		}
	}
	const tail = current.map((l) => l.text).join("\n").replace(/\n+$/, "");
	if (tail.trim()) chunks.push(tail);
	return chunks;
}

/** Convert a message typed in Slack back to plain text for the agent. */
export function slackToPlain(text: string): string {
	return text
		.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url.replace(/^mailto:/, "") ? label : `${label} (${url})`))
		.replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url: string) => url.replace(/^mailto:/, ""))
		.replace(/<#C\w+\|([^>]+)>/g, "#$1")
		.replace(/<!(here|channel|everyone)>/g, "@$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}
