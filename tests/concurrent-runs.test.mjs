import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../src/state.ts";
import { createSharedCompactionCheckpoint, markCompactionParticipant, pendingSharedCompaction } from "../src/context-coordination.ts";
import { appendSupervisorMemory, loadSupervisorMemory } from "../src/supervisor-memory.ts";

const work = mkdtempSync(join(tmpdir(), "gm-concurrent-"));
mkdirSync(join(work, ".goal-mode-pi"), { recursive: true });
writeFileSync(join(work, ".goal-mode-pi", "supervisor-memory.md"), "旧任务：作品集必须部署到 Vercel\n");
const a = loadState({ workdir: work, scopeId: "thread-a", goal: "任务 A" });
const b = loadState({ workdir: work, scopeId: "thread-b", goal: "任务 B" });
a.trueIntent = "保留 A"; b.trueIntent = "保留 B";
saveState(a); saveState(b);
const aReload = loadState({ workdir: work, scopeId: "thread-a" });
const bReload = loadState({ workdir: work, scopeId: "thread-b" });
if (aReload.trueIntent !== "保留 A" || bReload.trueIntent !== "保留 B") throw new Error("并发监督状态串线");

const checkpoint = createSharedCompactionCheckpoint(work, "executor", "thread-a");
markCompactionParticipant(work, "supervisor", "requested", checkpoint, "", "thread-a");
if (!pendingSharedCompaction(work, "supervisor", "thread-a")) throw new Error("A 没收到自己的压缩请求");
if (pendingSharedCompaction(work, "supervisor", "thread-b")) throw new Error("B 收到了 A 的压缩请求");
const aStatePath = join(work, ".goal-mode-pi", "runs", "thread-a", "state.json");
if (JSON.parse(readFileSync(aStatePath, "utf8")).goal !== "任务 A") throw new Error("会话状态路径错误");

appendSupervisorMemory(work, "A 的机器人字段核验规则", "thread-a");
appendSupervisorMemory(work, "B 的作品集发布规则", "thread-b");
if (!loadSupervisorMemory(work, "thread-a").includes("机器人字段") || loadSupervisorMemory(work, "thread-a").includes("作品集")) {
	throw new Error("会话记忆串线");
}
if (loadSupervisorMemory(work, "thread-b").includes("机器人字段")) throw new Error("会话记忆串线");
if (loadSupervisorMemory(work, "thread-a").includes("Vercel")) throw new Error("旧项目级记忆污染了新任务");
appendSupervisorMemory(work, "task A 的专属判断", "thread-a", "task-a");
if (!loadSupervisorMemory(work, "thread-a", "task-a").includes("专属判断")) throw new Error("任务记忆没有落入 taskId 分区");
if (loadSupervisorMemory(work, "thread-a", "task-b").includes("专属判断")) throw new Error("同一会话的不同任务记忆串线");

// 任务切换后，上一任务尚未消费的压缩请求必须失效。
aReload.taskId = "task-new";
aReload.contractVersion = 2;
saveState(aReload);
if (pendingSharedCompaction(work, "supervisor", "thread-a")) throw new Error("新任务错误消费了旧任务压缩检查点");
rmSync(work, { recursive: true, force: true });
console.log("✅ 多线程隔离：同项目两会话的监督状态、压缩请求和任务记忆互不串线");
