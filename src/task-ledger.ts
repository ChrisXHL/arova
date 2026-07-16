import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type EvidenceKind = "tool" | "file" | "url" | "browser" | "user" | "runtime";
export type GapStatus = "open" | "resolved" | "blocked";
export type AttemptOutcome = "success" | "no_new_evidence" | "blocked" | "failed";
export type BlockerKind = "none" | "access" | "missing_data" | "tool_failure" | "conflict" | "unknown";

export interface TaskRequirement { id: string; description: string; evidence: string; }
export interface TaskFact { id: string; claim: string; evidence: string; kind: EvidenceKind; }
export interface TaskHypothesis { id: string; statement: string; status: "open" | "validated" | "rejected"; evidence: string; }
export interface TaskGap { id: string; question: string; critical: boolean; status: GapStatus; resolution: string; }
export interface TaskAttempt { action: string; outcome: AttemptOutcome; blocker: BlockerKind; learned: string; nextAction: string; at: string; }

export interface TaskLedger {
	taskId: string;
	contractVersion: number;
	goal: string;
	requirements: TaskRequirement[];
	facts: TaskFact[];
	hypotheses: TaskHypothesis[];
	gaps: TaskGap[];
	attempts: TaskAttempt[];
	nextAction: string;
}

const empty = (): TaskLedger => ({ taskId: "", contractVersion: 0, goal: "", requirements: [], facts: [], hypotheses: [], gaps: [], attempts: [], nextAction: "" });
const file = (workdir: string, scopeId?: string) => scopeId ? join(workdir, ".goal-mode-pi", "runs", scopeId, "task-ledger.json") : join(workdir, ".goal-mode-pi", "task-ledger.json");

export function loadTaskLedger(workdir: string, scopeId?: string): TaskLedger {
	try { return { ...empty(), ...JSON.parse(readFileSync(file(workdir, scopeId), "utf8")) } as TaskLedger; } catch { return empty(); }
}
export function saveTaskLedger(workdir: string, ledger: TaskLedger, scopeId?: string): TaskLedger {
	const target = file(workdir, scopeId); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(ledger, null, 2)); return ledger;
}
export function isCurrentTaskLedger(ledger: TaskLedger, taskId: string, version: number): boolean {
	return !!ledger.requirements.length && ledger.taskId === taskId && ledger.contractVersion === version;
}
export function validateRequirements(items: Array<{ id: string; description: string }>): string | undefined {
	if (!items.length) return "至少写出一个可验证的任务要求。";
	if (items.some((item) => !item.id.trim() || !item.description.trim())) return "每个任务要求都需要 id 和 description。";
	if (new Set(items.map((item) => item.id.trim())).size !== items.length) return "任务要求 id 不能重复。";
	return undefined;
}
export function taskCompletionProblem(ledger: TaskLedger, taskId: string, version: number): string | undefined {
	if (!isCurrentTaskLedger(ledger, taskId, version)) return "当前任务没有 task ledger；先定义可验证要求、事实、缺口和证据。";
	const missingEvidence = ledger.requirements.filter((item) => item.evidence.trim().length < 12);
	if (missingEvidence.length) return `任务要求尚未有完成证据：${missingEvidence.map((item) => item.id).join("、")}。`;
	const criticalGaps = ledger.gaps.filter((item) => item.critical && item.status !== "resolved");
	if (criticalGaps.length) return `关键缺口尚未闭合：${criticalGaps.map((item) => item.id).join("、")}。`;
	const openHypotheses = ledger.hypotheses.filter((item) => item.status === "open");
	if (openHypotheses.length) return `仍有未验证假设：${openHypotheses.map((item) => item.id).join("、")}。`;
	if (!ledger.facts.length && !ledger.attempts.some((item) => item.outcome === "success")) return "没有记录任何已验证事实或成功行动，不能只凭文字结论完成。";
	return undefined;
}
