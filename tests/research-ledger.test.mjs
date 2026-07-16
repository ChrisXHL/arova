import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { coverage, isTextFetchBlocked, researchCompletionProblem, saveResearchLedger } = await import(join(root, "src/research-ledger.ts"));
const { createSupervisorExtension } = await import(join(root, "src/supervisor-extension.ts"));
const { loadState } = await import(join(root, "src/state.ts"));

const work = mkdtempSync(join(tmpdir(), "gm-research-"));
let ok = 0, bad = 0;
const t = (name, pass) => pass ? ok++ : (bad++, console.log("❌", name));

const base = {
  taskId: "r1", contractVersion: 1, goal: "研究 Unitree G1 参数", officialDomains: ["support.unitree.com"],
  fields: [{ id: "weight", label: "重量", critical: true }, { id: "sdk", label: "SDK 文档", critical: false }], visits: [], evidence: [],
};

saveResearchLedger(work, base);
t("缺失关键字段不能完成", researchCompletionProblem(base, "r1", 1).includes("weight=missing"));
const one = { ...base, evidence: [{ fieldId: "weight", value: "35 kg", url: "https://support.unitree.com/g1", sourceKind: "official_page", independentKey: "unitree-g1-doc", observedAt: "2026-07-15", note: "规格页" }] };
t("单一官方来源仍需交叉验证", coverage(one)[0].state === "single");
const verified = { ...one, evidence: [...one.evidence, { fieldId: "weight", value: "35 kg", url: "https://independent.example/g1", sourceKind: "independent", independentKey: "independent-lab", observedAt: "2026-07-15", note: "独立资料" }] };
t("官方加独立一致数值通过", coverage(verified)[0].state === "verified" && !researchCompletionProblem(verified, "r1", 1));
const copied = { ...one, evidence: [...one.evidence, { fieldId: "weight", value: "35 kg", url: "https://copy.example/g1", sourceKind: "independent", independentKey: "unitree-g1-doc", observedAt: "2026-07-15", note: "转载同一公告" }] };
t("同源转载不伪装成交叉验证", coverage(copied)[0].state === "single");
const conflict = { ...verified, evidence: [...verified.evidence, { fieldId: "weight", value: "47 kg", url: "https://other.example/g1", sourceKind: "independent", independentKey: "other", observedAt: "2026-07-15", note: "版本待确认" }] };
t("冲突数值必须暴露", coverage(conflict)[0].state === "conflict");

const state = loadState({ taskId: "r1", contractVersion: 1, goal: "研究 Unitree G1 参数", latestRequest: "", workdir: work, testCmd: "" });
const tools = new Map();
createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });
const text = (r) => r.content[0].text;
t("研究账本工具已注册", tools.has("set_research_contract") && tools.has("record_research_evidence") && tools.has("assess_research_coverage"));
t("WAF 拦截被可靠识别", isTextFetchBlocked("请求已被站点的安全策略拦截。由 Tencent Cloud EdgeOne 提供防护"));

rmSync(work, { recursive: true, force: true });
console.log(bad ? `❌ ${bad} 项失败` : `✅ 研究证据账本：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
