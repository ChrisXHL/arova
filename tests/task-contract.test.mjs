import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTaskContract, isStatusOnlyFollowup, loadTaskContract, repairLegacyTaskBoundary, shouldStartNewTask, taskContractBrief } from "../src/task-contract.ts";

const work = mkdtempSync(join(tmpdir(), "gm-contract-"));
captureTaskContract(work, '<skill name="workflow-automator">必须先拆分并验证工作流</skill>\n\n用这个 skill 做一个可运行的工作流', "thread-a");
captureTaskContract(work, "不要跳过验证，继续完成", "thread-a");
const contract = loadTaskContract(work, "thread-a");
assert.equal(contract.primaryGoal, "用这个 skill 做一个可运行的工作流");
assert.equal(contract.referencedSkills[0].name, "workflow-automator");
assert.match(taskContractBrief(contract), /必须先拆分并验证工作流/);
assert.match(taskContractBrief(contract), /不要跳过验证/);
assert.equal(loadTaskContract(work, "thread-b").primaryGoal, "", "会话契约不能串线");

const versionBeforeContinue = contract.version;
captureTaskContract(work, "继续", "thread-a");
assert.equal(loadTaskContract(work, "thread-a").version, versionBeforeContinue, "继续不能制造要求或覆盖主目标");
captureTaskContract(work, "【监督要求重做｜第 9 轮】补一个没写过的伪要求", "thread-a");
assert.equal(loadTaskContract(work, "thread-a").version, versionBeforeContinue, "监督回灌不能伪装成用户合同");
assert.doesNotMatch(taskContractBrief(loadTaskContract(work, "thread-a")), /伪要求/);

for (let i = 1; i <= 30; i++) captureTaskContract(work, `第 ${i} 项长期要求必须完整保留`, "thread-a");
for (let i = 1; i <= 15; i++) captureTaskContract(work, `<skill name="skill-${i}">第 ${i} 个 skill 的完整规则</skill>`, "thread-a");
const longContract = loadTaskContract(work, "thread-a");
assert.equal(longContract.requirements.length, 32, "不能只保留最近 24 条要求");
assert.equal(longContract.referencedSkills.length, 16, "不能只保留最近 12 个 skill");
assert.match(taskContractBrief(longContract), /第 1 项长期要求必须完整保留/);
assert.match(taskContractBrief(longContract), /skill-15/);

const oldTaskId = longContract.taskId;
captureTaskContract(work, "新任务：修复另一个完全独立的问题", "thread-a");
const nextTask = loadTaskContract(work, "thread-a");
assert.notEqual(nextTask.taskId, oldTaskId, "显式新任务必须隔离 taskId");
assert.equal(nextTask.primaryGoal, "修复另一个完全独立的问题");
assert.deepEqual(nextTask.requirements, ["修复另一个完全独立的问题"]);
assert.deepEqual(nextTask.referencedSkills, []);

// 真实事故回归：旧任务即使没被监督 mark_complete，只要上一轮已交付，新的独立动作句也必须换代。
const boundaryScope = "thread-boundary";
captureTaskContract(work, "/skill:roboatlas-api 查询补充 Figure 01 空字段，校对后写入数据库", boundaryScope, {
  resolveSkillInstructions: (name) => name === "roboatlas-api" ? "从能力目录直接读取的完整 API 规则" : undefined,
});
let boundary = loadTaskContract(work, boundaryScope);
assert.equal(boundary.referencedSkills[0]?.name, "roboatlas-api", "只收到 /skill 命令时也必须立即记住 skill 名");
assert.equal(boundary.referencedSkills[0]?.instructions, "从能力目录直接读取的完整 API 规则", "只收到 /skill 命令时也必须同步持久化完整规则");
captureTaskContract(work, '<skill name="roboatlas-api">完整 API 规则</skill>\n\n查询补充 Figure 01 空字段，校对后写入数据库', boundaryScope);
boundary = loadTaskContract(work, boundaryScope);
assert.equal(boundary.requirements.length, 1, "/skill 命令展开前后不能把同一要求记录两遍");
assert.equal(boundary.referencedSkills[0]?.instructions, "完整 API 规则", "收到展开正文后必须补全 skill 规则");
const boundaryTaskId = boundary.taskId;
const boundaryVersion = boundary.version;
assert.equal(isStatusOnlyFollowup("通过接口写入成功了吗?"), true);
captureTaskContract(work, "通过接口写入成功了吗?", boundaryScope);
boundary = loadTaskContract(work, boundaryScope);
assert.equal(boundary.version, boundaryVersion, "状态询问不能让合同、计划和测试证据失效");
assert.equal(shouldStartNewTask(boundary, "还要覆盖重复记录和空输入", { previousTurnSettled: true }), false);
assert.equal(shouldStartNewTask(boundary, "标题改一下", { previousTurnSettled: true }), false);
assert.equal(shouldStartNewTask(boundary, "/skill:roboatlas-api 你通过接口验证一下 Figure 01 的全部数据", { previousTurnSettled: true }), true);
captureTaskContract(work, "/skill:roboatlas-api 你通过接口验证一下 Figure 01 的全部数据", boundaryScope, { forceNewTask: true });
boundary = loadTaskContract(work, boundaryScope);
assert.notEqual(boundary.taskId, boundaryTaskId);
assert.equal(boundary.primaryGoal, "你通过接口验证一下 Figure 01 的全部数据");
assert.deepEqual(boundary.requirements, ["你通过接口验证一下 Figure 01 的全部数据"]);
assert.equal(boundary.referencedSkills[0]?.name, "roboatlas-api", "新任务重新点名的 skill 不能在切换 taskId 时丢失");
assert.equal(boundary.referencedSkills[0]?.instructions, "完整 API 规则", "同名 skill 应继承已加载的完整规则");

// 已经被旧版污染的现场会话在新版启动时自动修复，不要求用户重复输入一次。
const legacyScope = "legacy-figure";
const legacyDir = join(work, ".goal-mode-pi", "runs", legacyScope);
mkdirSync(legacyDir, { recursive: true });
writeFileSync(join(legacyDir, "task-contract.json"), JSON.stringify({
  schemaVersion: 2,
  taskId: "task-old-figure",
  version: 5,
  primaryGoal: "/skill:roboatlas-api 查询补充 Figure 01 空字段，校对后写入数据库",
  latestRequest: "你通过接口验证一下 Figure 01 的全部数据",
  requirements: [
    "/skill:roboatlas-api 查询补充 Figure 01 空字段，校对后写入数据库",
    "查询补充 Figure 01 空字段，校对后写入数据库",
    "/skill:roboatlas-api 你通过接口验证一下 Figure 01 的全部数据",
    "你通过接口验证一下 Figure 01 的全部数据",
  ],
  referencedSkills: [{ name: "roboatlas-api", instructions: "完整 API 规则" }],
  updatedAt: new Date().toISOString(),
}, null, 2));
const repaired = repairLegacyTaskBoundary(work, legacyScope, { progress: 70 });
assert.notEqual(repaired.taskId, "task-old-figure");
assert.equal(repaired.primaryGoal, "你通过接口验证一下 Figure 01 的全部数据");
assert.deepEqual(repaired.requirements, ["你通过接口验证一下 Figure 01 的全部数据"]);
assert.equal(repaired.referencedSkills[0]?.name, "roboatlas-api", "自愈切换不能遗忘用户在新任务重新引用的 skill");
console.log("✅ 任务契约：主目标稳定、监督指令隔离、全量要求/skill 保留且新任务切换正确");
