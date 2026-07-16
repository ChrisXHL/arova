import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionHasUserInteraction } from "../src/session-reuse.ts";

const work = mkdtempSync(join(tmpdir(), "gm-session-reuse-"));
const writeSession = (id, records) => {
  const dir = join(work, ".goal-mode-pi", "sessions", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chat.jsonl"), records.map((r) => JSON.stringify({ type: "message", message: { role: r[0], content: [{ type: "text", text: r[1] }] } })).join("\n"));
};

writeSession("empty", [["assistant", "我已经准备好了"]]);
writeSession("skill-only", [["user", "<skill name=\"demo\">系统注入</skill>"]]);
writeSession("started", [["user", "帮我修复重复新建会话"]]);

assert.equal(sessionHasUserInteraction(work, "empty"), false, "没有用户消息的会话应可复用");
assert.equal(sessionHasUserInteraction(work, "skill-only"), false, "skill 注入不算用户互动");
assert.equal(sessionHasUserInteraction(work, "started"), true, "真实用户输入后不得复用");
assert.equal(sessionHasUserInteraction(work, "../bad"), true, "非法会话 id 不可复用");
rmSync(work, { recursive: true, force: true });
console.log("✅ 空会话复用：只复用从未有真实用户输入的会话");
