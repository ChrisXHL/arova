import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ProductRequirement {
	id: string;
	title: string;
	userProblem: string;
	hypothesis: string;
	evidence: string;
	counterEvidence: string;
	metric: string;
	acceptance: string;
	nonGoal: string;
}
export interface RequirementImplementation { requirementId: string; codeEvidence: string; testEvidence: string; }
export interface ProductRequirementLedger {
	taskId: string;
	contractVersion: number;
	goal: string;
	requirements: ProductRequirement[];
	frozen: boolean;
	frozenAt: string;
	freezeReason: string;
	implementations: RequirementImplementation[];
}
const empty = (): ProductRequirementLedger => ({ taskId: "", contractVersion: 0, goal: "", requirements: [], frozen: false, frozenAt: "", freezeReason: "", implementations: [] });
const file = (workdir: string, scopeId?: string) => scopeId ? join(workdir, ".goal-mode-pi", "runs", scopeId, "product-requirements.json") : join(workdir, ".goal-mode-pi", "product-requirements.json");
export function loadProductRequirements(workdir: string, scopeId?: string): ProductRequirementLedger { try { return { ...empty(), ...JSON.parse(readFileSync(file(workdir, scopeId), "utf8")) } as ProductRequirementLedger; } catch { return empty(); } }
export function saveProductRequirements(workdir: string, ledger: ProductRequirementLedger, scopeId?: string): ProductRequirementLedger { const target = file(workdir, scopeId); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(ledger, null, 2)); return ledger; }
export function isCurrentProductRequirements(ledger: ProductRequirementLedger, taskId: string, version: number): boolean { return ledger.taskId === taskId && ledger.contractVersion === version && ledger.requirements.length > 0; }
export function validateProductRequirements(requirements: ProductRequirement[]): string | undefined {
	if (!requirements.length) return "至少需要一个产品需求。";
	if (new Set(requirements.map((item) => item.id)).size !== requirements.length) return "需求 id 不能重复。";
	for (const item of requirements) for (const [key, value] of Object.entries(item)) if (!String(value).trim()) return `需求 ${item.id} 缺少 ${key}；没有证据、反证、指标、验收或非目标项不能冻结。`;
	return undefined;
}
export function freezeProblem(ledger: ProductRequirementLedger, taskId: string, version: number): string | undefined {
	if (!isCurrentProductRequirements(ledger, taskId, version)) return "尚未建立当前版本的产品需求账本。";
	const invalid = validateProductRequirements(ledger.requirements); if (invalid) return invalid;
	if (!ledger.frozen) return "产品需求尚未冻结；不能开始编码。";
	return undefined;
}
export function implementationProblem(ledger: ProductRequirementLedger, taskId: string, version: number): string | undefined {
	const frozen = freezeProblem(ledger, taskId, version); if (frozen) return frozen;
	const missing = ledger.requirements.filter((requirement) => !ledger.implementations.some((item) => item.requirementId === requirement.id && item.codeEvidence.trim() && item.testEvidence.trim()));
	return missing.length ? `需求尚未建立代码与测试追溯：${missing.map((item) => item.id).join("、")}。` : undefined;
}
export const isProductTask = (text: string) => /产品|需求|用户故事|原型|功能设计|prd|功能/.test(text);
export const isProductBuildTask = (text: string) => isProductTask(text) && /实现|开发|编码|写代码|代码|构建|上线|功能/.test(text);
