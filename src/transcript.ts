import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { visibleUserText } from "./session-watch.ts";

export type TranscriptMessage = { role: "user" | "assistant"; text: string; tools: number };
export type TranscriptPage = { messages: TranscriptMessage[]; before: number | null; total: number };

export function sessionFiles(cwd: string, id: string): string[] | null {
	if (!/^[\w.-]+$/.test(id)) return null;
	const dir = join(cwd, ".goal-mode-pi", "sessions", id);
	if (!existsSync(dir)) return null;
	return readdirSync(dir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => join(dir, f))
		.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

export function parseTranscriptLines(lines: string[]): TranscriptMessage[] {
	const msgs: TranscriptMessage[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let o: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
		try { o = JSON.parse(line); } catch { continue; }
		if (o.type !== "message" || !o.message) continue;
		const { role, content = [] } = o.message;
		if (role !== "user" && role !== "assistant") continue;
		const rawText = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
		const text = role === "user" ? visibleUserText(rawText) : rawText.trim();
		const tools = content.filter((c) => c.type === "toolCall").length;
		if (!text && !tools) continue;
		const last = msgs[msgs.length - 1];
		if (last && last.role === role && role === "assistant") {
			last.text += text ? (last.text ? "\n" : "") + text : "";
			last.tools += tools;
		} else msgs.push({ role, text, tools });
	}
	return msgs.filter((m) => m.text || m.tools);
}

const cache = new Map<string, { signature: string; messages: TranscriptMessage[] }>();

/** 跨该 session 的所有 JSONL 建完整可见消息索引；分页只限制渲染量，不再丢历史。 */
export function readTranscriptPage(cwd: string, id: string, before?: number, limit = 100): TranscriptPage | null {
	const files = sessionFiles(cwd, id);
	if (!files?.length) return null;
	const signature = files.map((f) => { const s = statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; }).join("|");
	const key = `${cwd}\0${id}`;
	let messages = cache.get(key)?.signature === signature ? cache.get(key)!.messages : undefined;
	if (!messages) {
		messages = [];
		for (const file of files) messages.push(...parseTranscriptLines(readFileSync(file, "utf8").split("\n")));
		cache.set(key, { signature, messages });
	}
	const end = Math.max(0, Math.min(Number.isFinite(before) ? Number(before) : messages.length, messages.length));
	const start = Math.max(0, end - Math.max(1, Math.min(limit, 200)));
	return { messages: messages.slice(start, end), before: start > 0 ? start : null, total: messages.length };
}
