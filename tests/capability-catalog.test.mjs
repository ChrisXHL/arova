// 能力目录回归：监督必须明确看见会影响路径选择的 workflow 与 computer use。
import assert from "node:assert/strict";
import { capabilityDecisionBrief } from "../src/capability-catalog.ts";

const brief = capabilityDecisionBrief(
  ["workflow-automator", "workflow-orchestrator", "browser-use", "research-powerhouse", ...Array.from({ length: 20 }, (_, i) => `search-skill-${i + 1}`)],
  ["read", "bash", "observe_ui", "act_ui", "launch_browser", "navigate_browser"],
);

assert.match(brief, /workflow-automator/);
assert.match(brief, /workflow-orchestrator/);
assert.match(brief, /observe_ui/);
assert.match(brief, /act_ui/);
assert.match(brief, /能力目录/);
assert.match(brief, /默认浏览器检索/);
assert.match(brief, /search-skill-20/, "能力目录不能只显示前 12 个相关 skill");
assert.match(brief, /全部 skill 名称/);
console.log("✅ 监督能力目录：全部 skill、workflow 与 computer use 均已纳入决策上下文");
