import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSupervisorHistory, supervisorSessionManager, SupervisorHistoryWriter } from "../src/supervisor-history.ts";

const work = mkdtempSync(join(tmpdir(), "gm-supervisor-history-"));
const scope = "session-a";

const writer = new SupervisorHistoryWriter(work, scope);
writer.append({ kind: "supervisor", sub: "turn", text: "先审目标" });
writer.append({ kind: "supervisor", sub: "text", text: "发现" });
writer.append({ kind: "supervisor", sub: "text", text: "一个盲区" });
writer.append({ kind: "supervisor", sub: "tool", text: "git_diff" });
writer.append({ kind: "state", state: {} }); // 高频状态快照不写进流水历史
writer.close();

const page = readSupervisorHistory(work, scope);
if (!page || page.events.length !== 3) throw new Error("监督面板历史没有完整落盘");
if (page.events[1].kind !== "supervisor" || page.events[1].sub !== "text" || page.events[1].text !== "发现一个盲区") {
	throw new Error("监督文本 delta 没有正确合并");
}
if (readSupervisorHistory(work, "../escape")) throw new Error("监督历史 scope 没有阻止路径越界");

const first = supervisorSessionManager(work, scope);
first.appendMessage({ role: "user", content: "监督上下文测试", timestamp: Date.now() });
first.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "已记录判断依据" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
});
first.appendCustomEntry("history-test", { kept: true });
const second = supervisorSessionManager(work, scope);
if (!second.getEntries().some((e) => e.type === "custom" && e.customType === "history-test")) {
	throw new Error("监督 agent 的真实上下文没有按执行 session 续接");
}
const isolated = supervisorSessionManager(work, "session-b");
if (isolated.getEntries().length) throw new Error("不同执行 session 的监督上下文串线");
const taskA = supervisorSessionManager(work, scope, "task-a");
taskA.appendMessage({ role: "user", content: "task A 监督上下文", timestamp: Date.now() });
taskA.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "task A 已记录" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: Date.now(),
});
taskA.appendCustomEntry("task-history", { task: "a" });
const taskAResume = supervisorSessionManager(work, scope, "task-a");
if (!taskAResume.getEntries().some((e) => e.type === "custom" && e.customType === "task-history")) throw new Error("同一任务监督上下文没有续接");
const taskB = supervisorSessionManager(work, scope, "task-b");
if (taskB.getEntries().length) throw new Error("同一可见会话的不同 taskId 监督上下文串线");

const legacyDir = join(work, ".goal-mode-pi", "runs", "legacy-session");
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, "state.json"), JSON.stringify({ goal: "旧任务", trueIntent: "保护用户收益", reasoningAudit: { recommendation: "先验证核心假设" } }));
const legacy = readSupervisorHistory(work, "legacy-session");
if (!legacy?.events.some((e) => e.kind === "supervisor" && e.sub === "text" && e.text.includes("不是完整时间线"))) {
	throw new Error("升级前旧会话没有生成可辨识的监督摘要");
}

rmSync(work, { recursive: true, force: true });
console.log("✅ 监督历史：面板事件可回放，agent 上下文可续接，并发会话互不串线");
