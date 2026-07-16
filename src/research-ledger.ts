import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ResearchSourceKind = "official_page" | "official_attachment" | "official_ai" | "official_api" | "independent" | "community";
export type ResearchAccess = "read" | "blocked" | "no_new_data" | "not_relevant";

export interface ResearchField {
	id: string;
	label: string;
	critical: boolean;
}

export interface ResearchEvidence {
	fieldId: string;
	value: string;
	url: string;
	sourceKind: ResearchSourceKind;
	independentKey: string;
	observedAt: string;
	note: string;
}

export interface ResearchVisit {
	url: string;
	sourceKind: ResearchSourceKind;
	access: ResearchAccess;
	note: string;
	visitedAt: string;
}

export interface ResearchLedger {
	taskId: string;
	contractVersion: number;
	goal: string;
	officialDomains: string[];
	fields: ResearchField[];
	visits: ResearchVisit[];
	evidence: ResearchEvidence[];
}

const empty = (): ResearchLedger => ({ taskId: "", contractVersion: 0, goal: "", officialDomains: [], fields: [], visits: [], evidence: [] });

function file(workdir: string, scopeId?: string): string {
	return scopeId ? join(workdir, ".goal-mode-pi", "runs", scopeId, "research-ledger.json") : join(workdir, ".goal-mode-pi", "research-ledger.json");
}

export function loadResearchLedger(workdir: string, scopeId?: string): ResearchLedger {
	try {
		return { ...empty(), ...JSON.parse(readFileSync(file(workdir, scopeId), "utf8")) } as ResearchLedger;
	} catch {
		return empty();
	}
}

export function saveResearchLedger(workdir: string, ledger: ResearchLedger, scopeId?: string): ResearchLedger {
	const target = file(workdir, scopeId);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify(ledger, null, 2));
	return ledger;
}

export function isCurrentResearchLedger(ledger: ResearchLedger, taskId: string, contractVersion: number): boolean {
	return !!ledger.fields.length && ledger.taskId === taskId && ledger.contractVersion === contractVersion;
}

export function validateResearchFields(fields: ResearchField[]): string | undefined {
	if (!fields.length) return "至少定义一个要核实的字段。";
	if (fields.some((f) => !f.id || !f.label)) return "每个字段都需要 id 和 label。";
	if (new Set(fields.map((f) => f.id)).size !== fields.length) return "字段 id 不能重复。";
	return undefined;
}

/** WAF/反爬页面不是“资料未公开”；调用方必须切换浏览器通道。 */
export function isTextFetchBlocked(body: string): boolean {
	return /请求已被.*拦截|restricted access|edgeone|security policy.*blocked/i.test(body);
}

export function coverage(ledger: ResearchLedger): Array<{ field: ResearchField; state: "missing" | "single" | "verified" | "conflict"; values: string[] }> {
	return ledger.fields.map((field) => {
		const items = ledger.evidence.filter((item) => item.fieldId === field.id);
		const values = [...new Set(items.map((item) => item.value.trim()).filter(Boolean))];
		const independent = new Set(items.map((item) => item.independentKey.trim()).filter(Boolean));
		const hasOfficial = items.some((item) => item.sourceKind.startsWith("official_"));
		const state = values.length === 0 ? "missing" : values.length > 1 ? "conflict" : field.critical && (!hasOfficial || independent.size < 2) ? "single" : "verified";
		return { field, state, values };
	});
}

export function researchCompletionProblem(ledger: ResearchLedger, taskId: string, contractVersion: number): string | undefined {
	if (!isCurrentResearchLedger(ledger, taskId, contractVersion)) return "研究任务尚未建立当前版本的资料采集合同（字段、官方域名和证据账本）。";
	const rows = coverage(ledger);
	const bad = rows.filter((row) => row.field.critical && row.state !== "verified");
	if (bad.length) return `关键字段未达到交叉验证：${bad.map((row) => `${row.field.id}=${row.state}`).join("、")}。`;
	return undefined;
}
