import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProgressivePlan, needsWorkBreakdown, saveProgressivePlan, validateWorkPlan, verifyProgressiveWorkItem } from "../src/progressive-plan.ts";
import { createSupervisorExtension } from "../src/supervisor-extension.ts";
import { loadState } from "../src/state.ts";

const items = [
  { id: "evidence", title: "核验现状与证据", objective: "读取现状并建立可复查的事实基线", dependsOn: [], doneWhen: "证据表和现状快照均已落盘" },
  { id: "change", title: "实施最小改动", objective: "只根据已验证证据完成当前最小改动", dependsOn: ["evidence"], doneWhen: "变更可运行且关键结果可复现" },
];
assert.equal(needsWorkBreakdown("从零搭建一个完整平台，同时完成数据、前后端、部署、监控和文档"), true);
assert.equal(needsWorkBreakdown("把按钮颜色改成蓝色"), false);
assert.equal(needsWorkBreakdown("逐条验证接口中的几百条产品记录，每条使用相同证据规则"), false, "同构记录必须进入 Queue，不应误拆成阶段树");
assert.equal(validateWorkPlan("大任务", items, "evidence"), undefined);
assert.match(validateWorkPlan("大任务", [items[0]], "evidence"), /2-8/);
const work = mkdtempSync(join(tmpdir(), "gm-plan-"));
saveProgressivePlan(work, "大任务", items, "evidence", "thread-a", { taskId: "task-plan", contractVersion: 1 });
assert.equal(loadProgressivePlan(work, "thread-a").items[1].dependsOn[0], "evidence");
assert.equal(loadProgressivePlan(work, "thread-a").items[0].status, "active");
assert.throws(() => verifyProgressiveWorkItem(work, "change", "证据足够详细但试图跳过当前阶段，不能被放行。", undefined, "thread-a"), /只能核验当前阶段/);
let plan = verifyProgressiveWorkItem(work, "evidence", "已读取现状快照并核对证据表，所有关键事实均有可复查来源。", "change", "thread-a");
assert.equal(plan.items[0].status, "verified");
assert.equal(plan.currentId, "change");
plan = verifyProgressiveWorkItem(work, "change", "已运行最小改动并复现关键结果，阶段完成条件全部满足。", undefined, "thread-a");
assert.equal(plan.currentId, "");
assert.equal(plan.items.every((item) => item.status === "verified"), true);

// 完成工具必须把任务树作为硬门，而不是只完成第一阶段就宣布整单完成。
const largeGoal = "从零重构完整平台，覆盖数据前后端部署监控文档";
const gatedWork = mkdtempSync(join(tmpdir(), "gm-plan-gate-"));
const state = loadState({ goal: largeGoal, workdir: gatedWork, testCmd: "" });
state.taskId = "task-large"; state.contractVersion = 1;
const tools = new Map();
createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });
const completion = { files_inspected: "README.md", flaws_found: "逐段检查所有范围和证据", verification_method: "read", evidence: "已检查当前产出，但任务树仍应作为独立完成门，不能只凭本轮内容放行。" };
assert.match((await tools.get("mark_complete").execute("m1", completion)).content[0].text, /尚未建立渐进任务树/);
await tools.get("set_work_plan").execute("p1", { items: items.map((item) => ({ id: item.id, title: item.title, objective: item.objective, depends_on: item.dependsOn, done_when: item.doneWhen })), current_id: "evidence" });
assert.match((await tools.get("mark_complete").execute("m2", completion)).content[0].text, /未核验阶段/);
await tools.get("verify_work_item").execute("v1", { id: "evidence", evidence: "已读取现状快照并核对证据表，所有关键事实均有可复查来源。", next_id: "change" });
await tools.get("verify_work_item").execute("v2", { id: "change", evidence: "已运行最小改动并复现关键结果，阶段完成条件全部满足。" });
assert.doesNotMatch((await tools.get("mark_complete").execute("m3", completion)).content[0].text, /任务树/);
assert.equal(loadProgressivePlan(work, "thread-b").items.length, 0);
rmSync(work, { recursive: true, force: true });
rmSync(gatedWork, { recursive: true, force: true });
console.log("✅ 渐进任务树：阶段状态机、依赖推进、完成硬门、Queue 分流和会话隔离正常");
