import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.ts";
import { createSupervisorExtension } from "../src/supervisor-extension.ts";
import { saveProgressivePlan } from "../src/progressive-plan.ts";
import { saveGoalLedger } from "../src/goal-ledger.ts";

const work = mkdtempSync(join(tmpdir(), "gm-supervisor-generation-"));
const supervisor = new Supervisor({ workdir: work, testCmd: "", scopeId: "thread-a" });

supervisor.onUserTask("实现一个可靠的导入功能");
const firstTaskId = supervisor.state.taskId;
const firstVersion = supervisor.state.contractVersion;
supervisor.onUserTask("还要覆盖重复记录和空输入");
assert.equal(supervisor.state.taskId, firstTaskId, "普通补充不能换任务");
assert.equal(supervisor.state.goal, "实现一个可靠的导入功能", "普通补充不能覆盖稳定主目标");
assert.ok(supervisor.state.contractVersion > firstVersion);

const versionBeforeDirective = supervisor.state.contractVersion;
supervisor.onUserTask("【监督要求重做｜第 3 轮】这是自动生成的控制消息");
assert.equal(supervisor.state.contractVersion, versionBeforeDirective, "监督控制消息不能污染用户合同");

// start 尚未完成时，首轮审查不能丢；就绪后应读取包含所有补充的完整合同。
assert.ok(supervisor.pendingCritique, "启动前的用户输入必须排队");
const prompts = [];
supervisor.agent = {
  isStreaming: false,
  prompt: async (prompt) => { prompts.push(prompt); },
  abort: async () => {},
  dispose: () => {},
};
await supervisor.drainPendingWork();
assert.equal(prompts.length, 1);
assert.match(prompts[0], /实现一个可靠的导入功能/);
assert.match(prompts[0], /还要覆盖重复记录和空输入/);

const versionBeforeStatus = supervisor.state.contractVersion;
supervisor.onUserTask("当前任务完成了吗?");
assert.equal(supervisor.state.contractVersion, versionBeforeStatus, "状态询问不能制造新合同版本");
assert.equal(supervisor.state.goal, "实现一个可靠的导入功能");

// 不依赖 completed：执行端已经交付一轮后，独立动作句立即获得新 taskId。
saveProgressivePlan(work, supervisor.state.goal, [
  { id: "old1", title: "旧任务第一阶段", objective: "旧任务目标第一阶段必须完成", dependsOn: [], doneWhen: "旧任务第一阶段具有完整验收证据" },
  { id: "old2", title: "旧任务第二阶段", objective: "旧任务目标第二阶段必须完成", dependsOn: ["old1"], doneWhen: "旧任务第二阶段具有完整验收证据" },
], "old1", "thread-a", { taskId: supervisor.state.taskId, contractVersion: supervisor.state.contractVersion });
saveGoalLedger(work, supervisor.state.goal, [
  { id: "old_goal_1", requirement: "旧任务要求一必须完成", doneWhen: "旧任务要求一有明确可复查证据", status: "pending", evidence: "" },
  { id: "old_goal_2", requirement: "旧任务要求二必须完成", doneWhen: "旧任务要求二有明确可复查证据", status: "pending", evidence: "" },
], "thread-a", { taskId: supervisor.state.taskId, contractVersion: supervisor.state.contractVersion });
supervisor.noteExecutorTurnSettled();
supervisor.state.progress = 70;
const taskBeforeFigureAudit = supervisor.state.taskId;
supervisor.onUserTask("你通过接口验证一下 Figure 01 的全部数据");
assert.notEqual(supervisor.state.taskId, taskBeforeFigureAudit);
assert.equal(supervisor.state.goal, "你通过接口验证一下 Figure 01 的全部数据");
assert.equal(supervisor.state.progress, 0);
assert.equal(supervisor.state.trueIntent, "");
assert.match(supervisor.workPlanBrief(), /旧任务树已隔离/);
assert.match(supervisor.goalLedgerBrief(), /旧任务账本已隔离/);

const figureTaskId = supervisor.state.taskId;
supervisor.onUserTask("还要把中文视图也覆盖上");
assert.equal(supervisor.state.taskId, figureTaskId, "新任务内的明确补充仍应留在同一代际");

// 完成后只说“继续”仍恢复同一任务；发出实质新要求则自动切 taskId，避免旧记忆串入。
supervisor.state.completed = true;
supervisor.onUserTask("继续");
assert.equal(supervisor.state.taskId, figureTaskId);
supervisor.state.completed = true;
supervisor.onUserTask("分析另一个完全独立的数据源");
assert.notEqual(supervisor.state.taskId, figureTaskId);
assert.equal(supervisor.state.goal, "分析另一个完全独立的数据源");

// 已过期监督轮的工具没有写权限。
const guardedState = supervisor.state;
guardedState.progress = 7;
const tools = new Map();
createSupervisorExtension(guardedState, () => {}, () => false)({ registerTool: (tool) => tools.set(tool.name, tool) });
const staleResult = await tools.get("set_progress").execute("stale", { progress: 99, note: "旧任务结果" });
assert.equal(guardedState.progress, 7);
assert.match(staleResult.content[0].text, /已被用户的新输入取代/);

supervisor.stop();
rmSync(work, { recursive: true, force: true });
console.log("✅ 监督代际隔离：稳定主目标、启动排队、新任务切换与过期工具写保护通过");
