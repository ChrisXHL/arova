import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { corePolicy, executorBrief, humanVoicePolicy, outcomeFirstPolicy, responseLanguageInstruction, searchFallbackPolicy } = await import(join(root, "src/policy.ts"));

const supervisor = corePolicy();
const executor = executorBrief();
const directSupervisorRule = humanVoicePolicy("supervisor");
const supervisorSource = readFileSync(join(root, "src/supervisor.ts"), "utf8");
const orchestratorSource = readFileSync(join(root, "src/orchestrator.ts"), "utf8");
const rendererSource = readFileSync(join(root, "renderer/app.js"), "utf8");

const checks = [
	["监督端加载共用自然表达约束", supervisor.includes("自然表达——用户会直接读到这些话")],
	["执行端加载共用自然表达约束", executor.includes("自然表达——用户会直接读到这些话")],
	["两端都禁止复述和模板连接词", supervisor.includes("不复述用户原话") && executor.includes("首先、其次、最后")],
	["自然表达不牺牲事实和准确性", supervisor.includes("不能为了“像人”牺牲事实") && executor.includes("代码准确性")],
	["监督可见输出与后台审计分离", directSupervisorRule.includes("审计细节和工具字段留在后台")],
	["两端结果优先、规则兜底", supervisor.includes("结果优先，规则兜底") && executor.includes("结果优先，规则兜底")],
	["跳出僵化流程但不越过安全合规边界", outcomeFirstPolicy("executor").includes("不能把“跳出规则”理解为违法")],
	["接口受限时两端都降级到浏览器检索", supervisor.includes("检索降级") && executor.includes("检索降级")],
	["浏览器降级不绕过访问控制", searchFallbackPolicy("executor").includes("不绕过访问控制")],
	["目标审查和结果验收都重复近场约束", (supervisorSource.match(/humanVoicePolicy\("supervisor"\)/g) ?? []).length === 2],
	["旧 CLI 执行端也加载同一约束", orchestratorSource.includes('"--append-system-prompt", executorBrief()')],
	["中文输入锁定简体中文", responseLanguageInstruction("帮我检查一下这个项目").includes("本轮输出语言：简体中文")],
	["英文术语不会把中文任务带偏", responseLanguageInstruction("帮我检查 README 和 API schema").includes("所有给用户看的过程说明")],
	["监督目标审查和验收都注入本轮语言", (supervisorSource.match(/responseLanguageInstruction\(/g) ?? []).length === 2],
	["旧 CLI 监督也注入本轮语言", orchestratorSource.includes("responseLanguageInstruction(this.state.goal)")],
	["未知英文工具名不再原样漏到界面", rendererSource.includes('TOOL_CN[n] || "调用扩展工具"')],
];

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "✅" : "❌"} ${name}`);
if (failed.length) throw new Error(`自然表达回归失败：${failed.map(([name]) => name).join("、")}`);
