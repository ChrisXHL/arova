import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptPage } from "../src/transcript.ts";

const work = mkdtempSync(join(tmpdir(), "gm-transcript-"));
const id = "session-1";
const dir = join(work, ".goal-mode-pi", "sessions", id);
mkdirSync(dir, { recursive: true });
const line = (role, text) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const first = [], second = [];
for (let i = 0; i < 60; i++) first.push(line(i % 2 ? "assistant" : "user", `旧-${i}`));
for (let i = 60; i < 130; i++) second.push(line(i % 2 ? "assistant" : "user", `新-${i}`));
writeFileSync(join(dir, "a.jsonl"), first.join("\n") + "\n");
await new Promise((resolve) => setTimeout(resolve, 10));
writeFileSync(join(dir, "b.jsonl"), second.join("\n") + "\n");

const latest = readTranscriptPage(work, id);
if (!latest || latest.messages.length !== 100 || latest.before !== 30 || latest.total !== 130) throw new Error("最新页分页错误");
const older = readTranscriptPage(work, id, latest.before);
if (!older || older.messages.length !== 30 || older.before !== null || older.messages[0].text !== "旧-0") throw new Error("跨文件旧记录丢失");
console.log("✅ 历史详情分页：跨文件 130 条记录全部可读取");
