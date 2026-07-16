// 认知审计事实门回归：node --experimental-strip-types tests/reasoning-audit-gate.test.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createSupervisorExtension } = await import(join(root, "src/supervisor-extension.ts"));
const { loadState } = await import(join(root, "src/state.ts"));

const work = mkdtempSync(join(tmpdir(), "gm-audit-"));
const state = loadState({ goal: "判断这个产品方向是否值得做", workdir: work, testCmd: "" });
const tools = new Map();
createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });

const mark = tools.get("mark_complete");
const audit = tools.get("set_reasoning_audit");
const setFocus = tools.get("set_focus_contract");
const verifyFocus = tools.get("verify_focus_contract");
const runTests = tools.get("run_tests");
const inject = tools.get("inject_directive");
const setTaskLedger = tools.get("set_task_ledger");
const taskFact = tools.get("record_task_fact");
const verifyRequirement = tools.get("verify_task_requirement");
const completion = {
  files_inspected: "README.md 与产品方案",
  flaws_found: "逐段检查了逻辑、约束和遗漏，未发现未处理的问题",
  verification_method: "read, bash, git_diff",
  evidence: "已核对真实意图、实际产出和关键证据，当前方案在已知约束下可以直接使用。",
};
const txt = (r) => r.content[0].text;
let ok = 0, bad = 0;
const t = (name, pass) => pass ? ok++ : (bad++, console.log("❌", name));

t("没单点契约不能完成", txt(await mark.execute("1", completion)).includes("还没有单点契约"));
const focus = {
  point: "先用人工服务验证一个客户是否真实付费",
  first_principle: "真实需求最终表现为客户愿意用不可退的金钱交换实际结果",
  variables: ["真实付款金额", "是否无补贴", "是否完成交付"],
  calculation: "付款金额大于零且无补贴且完成交付，则记为一次真实需求验证",
  output: "真实需求成立或不成立",
  baseline: "口头表示感兴趣不计为真实需求",
  done_when: "获得至少一个无补贴真实付费订单并记录成交原因",
  deferred: ["暂不开发完整产品", "暂不扩展获客渠道"],
  next_trigger: "只有首个客户真实付费后才扩到第二个相邻客户样本",
};
t("大而全单点被拒", txt(await setFocus.execute("f0", { ...focus, point: "同时完整实现产品、增长以及商业化的全面系统" })).startsWith("拒绝"));
t("单点契约建立", txt(await setFocus.execute("f1", focus)).includes("当前只做这一个点"));
t("单点未核实不能完成", txt(await mark.execute("f2", completion)).includes("还没有事实闭环"));
t("无证据不能核实单点", txt(await verifyFocus.execute("f3", { evidence: "做完了", decision: "stop", reason: "可以了" })).startsWith("拒绝"));
t("单点证据闭环并停止扩张", txt(await verifyFocus.execute("f4", {
  evidence: "已核查真实支付凭证、访谈记录和交付结果，确认客户在无补贴情况下完成付款。",
  model_result: "付款金额大于零、无补贴且完成交付，按规则输出为真实需求成立，优于口头兴趣基线。",
  decision: "stop",
  reason: "当前证据只支持需求存在，不支持继续扩大产品范围，先停止最符合资金效率。",
})).includes("没有足够理由继续扩张"));
t("没做认知审计仍不能完成", txt(await mark.execute("f5", completion)).includes("还没有完成认知审计"));
t("套话式审计被拒绝", txt(await audit.execute("2", {
  user_value_function: "利益最大化",
  hidden_assumptions: "有风险", blind_spots: "需关注", disconfirming_evidence: "暂无",
  alternative_paths: "换方案", failure_premortem: "执行失败", recommendation: "看情况选择", verdict: "proceed",
})).startsWith("拒绝"));

const full = {
  user_value_function: "最大化真实付费需求的验证速度和资金效率，同时避免不可逆研发投入与品牌透支。",
  hidden_assumptions: "假设目标用户确实愿意改变现有工作流，但目前只有访谈判断，没有行为数据证明。",
  blind_spots: "遗漏了使用者之外的采购决策者、迁移成本，以及团队为了指标而制造表面活跃的可能。",
  disconfirming_evidence: "若试用用户在无补贴情况下留存仍低于现有方案，就应推翻需求强度足够这一判断。",
  alternative_paths: "先做人工服务验证真实付费，再决定是否产品化；成本更低、可逆性更强，但规模上限较低。",
  failure_premortem: "三个月后最可能发现用户口头认可却不愿迁移，今天错在把表达兴趣当成真实需求。",
  recommendation: "建议先用人工服务向真实客户收费验证，不做完整产品；它以更低成本保留转向空间，最符合用户当前利益。",
};
t("reframe 结论不能放行", txt(await audit.execute("3", { ...full, verdict: "reframe" })).includes("不能直接放行"));
t("reframe 后 mark_complete 仍拒绝", txt(await mark.execute("4", completion)).includes("reframe"));
t("重新审计为 proceed 后可完成", txt(await audit.execute("5", { ...full, verdict: "proceed" })).includes("原方向暂时胜出"));
state.testCmd = "true";
state.workRevision = 10;
t("当前版本测试通过", txt(await runTests.execute("t1", {})).includes("PASS") && state.lastTestRevision === 10);
await inject.execute("d1", { message: "根据新发现补齐边界处理并重新验证，不得沿用旧测试结论。" });
t("新修改要求使旧测试证据失效", txt(await mark.execute("6", completion)).includes("当前修改版本"));
t("新版本重新测试通过", txt(await runTests.execute("t2", {})).includes("PASS") && state.lastTestRevision === state.workRevision);
t("无 task ledger 仍不能完成", txt(await mark.execute("l0", completion)).includes("没有 task ledger"));
t("建立 task ledger", txt(await setTaskLedger.execute("l1", { requirements: [{ id: "validate-demand", description: "验证真实客户付费需求" }], next_action: "核对已留存的付款和交付证据" })).includes("task ledger 已建立"));
t("记录任务事实", txt(await taskFact.execute("l2", { id: "paid-order", claim: "客户在无补贴情况下完成付款且收到交付", evidence: "付款凭证、交付记录和访谈记录均已由监督核查", kind: "file" })).includes("已记录事实"));
t("任务要求写入完成证据", txt(await verifyRequirement.execute("l3", { id: "validate-demand", evidence: "付款凭证与交付记录显示客户无补贴完成付款，满足真实需求验证规则。" })).includes("已记录完成证据"));
t("完整事实门最终放行", txt(await mark.execute("7", completion)).startsWith("已确认目标达成"));

rmSync(work, { recursive: true, force: true });
console.log(bad ? `❌ ${bad} 项失败` : `✅ 认知审计事实门：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
