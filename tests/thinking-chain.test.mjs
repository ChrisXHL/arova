// 思维链插件回归：node --experimental-strip-types tests/thinking-chain.test.mjs
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = (await import(join(root, "src/thinking-chain-extension.ts"))).default;

const skillFile = join(tmpdir(), `gm-roboatlas-skill-${process.pid}.md`);
writeFileSync(skillFile, "---\nname: roboatlas-api\ndescription: API skill\n---\n\n必须逐字段读回并验证。\n");
const handlers = {}; const tools = new Map();
ext({
  on: (n, h) => (handlers[n] = h),
  registerTool: (t) => tools.set(t.name, t),
  getCommands: () => [{ name: "skill:roboatlas-api", source: "skill", sourceInfo: { path: skillFile } }],
});
const tool = tools.get("think_map");
const focus = tools.get("focus_step");
const work = mkdtempSync(join(tmpdir(), "gm-tct-"));
handlers.session_start({ cwd: work });
const bigDoc = { toolName: "write", input: { path: "/x/r.md", content: "字".repeat(900) } };
let ok = 0, bad = 0;
const t = (n, c) => { c ? ok++ : (bad++, console.log("❌", n)); };
const txt = (r) => r.content[0].text;

// —— 拦截语义 ——
t("没单点契约写大文档→拦", handlers.tool_call(bigDoc)?.reason.includes("单点契约"));
t("没单点契约小文件也拦", handlers.tool_call({ toolName: "write", input: { path: "/x/n.md", content: "短" } })?.block === true);
t("没单点契约代码也拦", handlers.tool_call({ toolName: "write", input: { path: "/x/a.ts", content: "x".repeat(2000) } })?.block === true);
const focusBase = {
  point: "先验证市场趋势这一条核心判断",
  first_principle: "方向判断首先取决于真实需求是在增长还是收缩，而不是功能数量",
  variables: ["市场规模同比变化", "目标用户付费增长"],
  calculation: "两项都为正则增长，任一连续为负则不增长",
  output: "增长或不增长",
  baseline: "与去年同期和零增长阈值比较",
  done_when: "找到两个独立来源并确认趋势方向一致",
  not_doing: ["暂不写完整报告", "暂不扩展商业模式分析"],
  next_trigger: "只有趋势判断站住后才扩到成本结构",
};
t("大而全的单点被拒", txt(await focus.execute("f0", { ...focusBase, point: "同时完整实现市场、产品以及商业模式的全面分析" })).startsWith("拒绝"));
t("最小可行模型契约放行", txt(await focus.execute("f1", focusBase)).startsWith("最小可行模型已锁定"));
t("有单点后小写入放行", handlers.tool_call({ toolName: "write", input: { path: "/x/n.md", content: "短" } }) === undefined);
t("有单点但没思维图，大文档仍拦", handlers.tool_call(bigDoc)?.reason.includes("思维链图"));

const base = {
  central: "社区团购项目值不值得做，要能直接指导投钱决策",
  conclusion: "不值得做：市场收缩且中小玩家成本结构无解",
  branches: [
    { dimension: "市场趋势", assumptions: ["市场还在增长"] },
    { dimension: "成本结构", known: "冷链单城投入 2000 万起" },
  ],
  framework: "目标-现状-差距：套上后补了'退出成本'漏项",
  verification: [{ assumption: "市场还在增长", method: "独立来源：查了两份行业报告，交易额连续两年下滑", result: "推翻，图已改" }],
  logic: [
    { from: "市场趋势", relation: "支撑", to: "结论" },
    { from: "成本结构", relation: "支撑", to: "结论" },
    { from: "市场还在增长", relation: "反驳", to: "结论" },
  ],
};

// —— 完整性校验 ——
t("无结论拒", txt(await tool.execute("i", { ...base, conclusion: "短" })).startsWith("拒绝"));
t("单维度拒", txt(await tool.execute("i", { ...base, branches: [base.branches[0]] })).startsWith("拒绝"));
t("假设没验证拒", txt(await tool.execute("i", { ...base, verification: [] })).includes("没有交叉验证"));
t("验证敷衍拒", txt(await tool.execute("i", { ...base, verification: [{ assumption: "市场还在增长", method: "想了下", result: "对" }] })).startsWith("拒绝"));

// —— 逻辑校验 ——
t("无边拒", txt(await tool.execute("i", { ...base, logic: [] })).includes("没有一条逻辑边"));
t("坏引用拒", txt(await tool.execute("i", { ...base, logic: [{ from: "不存在的节点", relation: "支撑", to: "结论" }] })).includes("对不上任何节点"));
t("孤岛拒", txt(await tool.execute("i", { ...base, logic: [{ from: "市场趋势", relation: "支撑", to: "结论" }, { from: "市场趋势", relation: "支撑", to: "结论" }] })).includes("孤岛"));
t("支撑不足拒", txt(await tool.execute("i", { ...base, logic: [{ from: "市场趋势", relation: "支撑", to: "结论" }, { from: "成本结构", relation: "依赖", to: "市场趋势" }] })).includes("少于 2 条"));
t("推翻的假设撑结论→拒", txt(await tool.execute("i", { ...base, logic: [...base.logic.slice(0, 2), { from: "市场还在增长", relation: "支撑", to: "结论" }] })).includes("自相矛盾"));

// —— 闭环放行 + 落盘 ——
t("闭环放行", txt(await tool.execute("i", base)).startsWith("逻辑闭环"));
t("放行后不拦", handlers.tool_call(bigDoc) === undefined);
const thinkingDir = join(work, ".goal-mode-pi", "thinking");
const f = readFileSync(join(thinkingDir, readdirSync(thinkingDir).find((n) => n.endsWith(".md"))), "utf8");
t("flowchart+边+样式落盘", f.includes("flowchart TD") && f.includes("-- 支撑 -->") && f.includes("-. 反驳 .->") && f.includes("class A0 refuted"));
t("结论+逻辑关系入档", f.includes("**结论**") && f.includes("## 逻辑关系"));
const snapshot = JSON.parse(readFileSync(join(thinkingDir, "latest.json"), "utf8"));
t("可解释快照已放行", snapshot.status === "approved" && snapshot.central === base.central);
t("快照含验证与自动校验", snapshot.verification.length === 1 && snapshot.checks.supportingEdges === 2);

// —— 上下文治理：65% 提前压缩，摘要必须保留当前 MVM ——
let smallCompact = false;
handlers.agent_end({}, {
  getContextUsage: () => ({ tokens: 130000, contextWindow: 200000, percent: 65 }),
  sessionManager: { getEntries: () => [{ type: "message", content: "短会话" }] },
  compact: () => { smallCompact = true; },
});
t("系统提示占比高但会话太小时不压缩", smallCompact === false);
let forkedHistoryCompact = false;
handlers.agent_end({}, {
  getContextUsage: () => ({ tokens: 130000, contextWindow: 200000, percent: 65 }),
  // 已放弃的旧分支可以很长，但 Pi 只会压缩 getBranch() 返回的当前路径。
  sessionManager: {
    getEntries: () => Array.from({ length: 20 }, (_, i) => ({ type: "message", id: `old-${i}`, content: "x".repeat(7000) })),
    getBranch: () => [{ type: "message", id: "current", content: "当前分支很短" }],
  },
  compact: () => { forkedHistoryCompact = true; },
});
await new Promise((resolve) => setTimeout(resolve, 250));
t("旧分支再长也不误触发当前分支压缩", forkedHistoryCompact === false);
let compactOpts = null;
let idle = false;
handlers.agent_end({}, {
  getContextUsage: () => ({ tokens: 130000, contextWindow: 200000, percent: 65 }),
  // 13 条完整 Pi message：超过 keepRecentTokens，且至少留出一条旧消息可摘要。
  sessionManager: { getEntries: () => Array.from({ length: 13 }, (_, i) => ({ type: "message", id: String(i), parentId: i ? String(i - 1) : null, message: { role: "user", content: "x".repeat(7000) } })) },
  isIdle: () => idle,
  hasPendingMessages: () => false,
  compact: (opts) => { compactOpts = opts; opts.onComplete({}); },
});
t("agent_end 回调栈内不直接压缩", compactOpts === null);
idle = true;
await new Promise((resolve) => setTimeout(resolve, 250));
t("真正 idle 后触发上下文压缩", !!compactOpts);
t("压缩指令保留 MVM 与关键状态", compactOpts.customInstructions.includes("Minimum Viable Model") && compactOpts.customInstructions.includes(focusBase.point));
const ctxStatus = JSON.parse(readFileSync(join(work, ".goal-mode-pi", "context", "latest.json"), "utf8"));
t("压缩状态可见", ctxStatus.status === "compacted");

// —— 重置语义 ——
handlers.input({ text: "帮我写一份完整的竞品分析报告" });
t("新任务重置→再拦", handlers.tool_call(bigDoc)?.block === true);
await focus.execute("f2", focusBase);
await tool.execute("i", base);
handlers.input({ text: "标题改一下" });
t("短反馈不重置", handlers.tool_call(bigDoc) === undefined);
handlers.input({ text: "【监督要求重做｜第 1 轮】目标：补充数据来源" });
t("监督指令不重置", handlers.tool_call(bigDoc) === undefined);
handlers.agent_end({}, {
  getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
  sessionManager: { getEntries: () => [] },
});
handlers.input({ text: "/skill:roboatlas-api 你通过接口验证一下 Figure 01 的全部数据" });
const switchedContract = JSON.parse(readFileSync(join(work, ".goal-mode-pi", "task-contract.json"), "utf8"));
t("/skill 输入事件本身已持久化完整规则", switchedContract.referencedSkills[0]?.instructions.includes("必须逐字段读回并验证"));
handlers.input({ text: '<skill name="roboatlas-api">完整 API 规则</skill>\n\n你通过接口验证一下 Figure 01 的全部数据' });
const expandedContract = JSON.parse(readFileSync(join(work, ".goal-mode-pi", "task-contract.json"), "utf8"));
t("skill 展开双事件只切换一次 taskId", expandedContract.taskId === switchedContract.taskId && expandedContract.requirements.length === 1);
t("上一轮交付后的独立动作自动切新任务", handlers.tool_call(bigDoc)?.block === true);

console.log(bad ? `❌ ${bad} 项失败` : `✅ 思维链插件回归：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
