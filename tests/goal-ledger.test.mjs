import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisorExtension } from "../src/supervisor-extension.ts";
import { loadGoalLedger, needsGoalLedger } from "../src/goal-ledger.ts";
import { loadState } from "../src/state.ts";

const work = mkdtempSync(join(tmpdir(), "gm-ledger-"));
const state = loadState({ goal: "先整理数据，然后校验结果，最后写入数据库并复查", workdir: work, testCmd: "" });
state.taskId = "task-ledger";
state.contractVersion = 1;
const tools = new Map();
createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });
const text = (result) => result.content[0].text;
const mark = tools.get("mark_complete");
const setLedger = tools.get("set_goal_ledger");
const verify = tools.get("verify_goal_item");
const completion = { files_inspected: "output.md", flaws_found: "检查了遗漏和证据", verification_method: "read", evidence: "已检查产出".repeat(10) };

assert.equal(needsGoalLedger({ primaryGoal: state.goal, latestRequest: state.goal, requirements: [state.goal], referencedSkills: [], updatedAt: "" }, state.goal), true);
assert.equal(needsGoalLedger({ primaryGoal: "修复按钮", latestRequest: "颜色改蓝", requirements: ["修复按钮", "颜色改蓝"], referencedSkills: [], updatedAt: "" }, "修复按钮"), false, "普通补充不能被误判成多流程官僚账本");
assert.match(text(await mark.execute("m1", completion)), /尚未建立目标账本/);
const ledgerItems = [
  { id: "prepare", requirement: "整理数据并形成基线", done_when: "数据清单已保存且缺口已标记" },
  { id: "verify", requirement: "校验结果并记录差异", done_when: "关键字段逐项核验并保留证据" },
  { id: "writeback", requirement: "写入数据库并读后复查", done_when: "写入成功且读取结果与预期一致" },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `flow_${i + 1}`, requirement: `额外流程 ${i + 1} 的用户要求必须保留`, done_when: `额外流程 ${i + 1} 已按证据完成并可独立复查` })),
];
assert.match(text(await setLedger.execute("s1", { items: ledgerItems })), /目标账本已建立/);
assert.equal(loadGoalLedger(work).items.length, 15, "目标账本不能只接收前 12 个流程");
assert.match(text(await mark.execute("m2", completion)), /未核验项/);
for (const { id } of ledgerItems) assert.match(text(await verify.execute(id, { id, evidence: "通过读取原始数据、运行校验并保存输出，确认该项完成标准已满足。" })), /已核验/);
assert.equal(loadGoalLedger(work).items.every((item) => item.status === "verified"), true);
state.contractVersion = 2;
assert.match(text(await mark.execute("m3", completion)), /旧合同版本/, "合同有新要求后旧账本不能放行");
assert.match(text(await setLedger.execute("s2", { items: ledgerItems })), /目标账本已建立/);
assert.equal(loadGoalLedger(work).contractVersion, 2);
assert.equal(loadGoalLedger(work).items.every((item) => item.status === "verified"), true, "同一任务中未变化的验收项应保留证据");
rmSync(work, { recursive: true, force: true });
console.log("✅ 目标账本：全量流程、合同版本绑定、证据继承与逐项完成门通过");
