import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskContractText, type TaskContract } from "./task-contract.ts";

export type GoalLedgerItem = {
	id: string;
	requirement: string;
	doneWhen: string;
	status: "pending" | "active" | "verified" | "skipped";
	evidence: string;
};
export type GoalLedger = { taskId: string; contractVersion: number; goal: string; items: GoalLedgerItem[]; updatedAt: string };
const EMPTY: GoalLedger = { taskId: "", contractVersion: 0, goal: "", items: [], updatedAt: "" };

function file(workdir: string, scopeId?: string): string {
	return scopeId ? join(workdir, ".goal-mode-pi", "runs", scopeId, "goal-ledger.json") : join(workdir, ".goal-mode-pi", "goal-ledger.json");
}

/** 多流程/多约束不是“记在 prompt 里”，而是必须进入完成门的账本。 */
export function needsGoalLedger(contract: TaskContract, fallbackGoal = ""): boolean {
	const text = taskContractText(contract, fallbackGoal);
	if (contract.requirements.length >= 3) return true;
	const explicitMultiple = /先.{0,80}(再|然后|之后)|然后|之后|以及|并且|同时|分别|每个|所有.*(并|再)/.test(text);
	return explicitMultiple || (text.length >= 180 && /目标|流程|步骤|要求|验收/.test(text));
}

export function loadGoalLedger(workdir: string, scopeId?: string): GoalLedger {
	try {
		const saved = JSON.parse(readFileSync(file(workdir, scopeId), "utf8")) as Partial<GoalLedger>;
		return { ...EMPTY, ...saved, items: Array.isArray(saved.items) ? saved.items : [] };
	} catch { return { ...EMPTY }; }
}

export function validateGoalLedger(items: GoalLedgerItem[]): string | undefined {
	if (items.length < 2) return "目标账本至少需要 2 个不可遗漏的验收项；每项对应用户的一项目标或流程。";
	const ids = new Set<string>();
	for (const item of items) {
		if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(item.id) || ids.has(item.id)) return "每个验收项必须有唯一、简短的 id。";
		ids.add(item.id);
		if (item.requirement.trim().length < 8 || item.doneWhen.trim().length < 12) return `验收项 ${item.id} 必须写清用户要什么，以及可观察的完成标准。`;
	}
	return undefined;
}

export function saveGoalLedger(
	workdir: string,
	goal: string,
	items: GoalLedgerItem[],
	scopeId?: string,
	binding: { taskId?: string; contractVersion?: number; preserveVerified?: boolean } = {},
): GoalLedger {
	const previous = loadGoalLedger(workdir, scopeId);
	const sameTask = !!binding.taskId && previous.taskId === binding.taskId;
	const oldByIdentity = new Map(previous.items.map((item) => [`${item.id}\u0000${item.requirement}\u0000${item.doneWhen}`, item]));
	const mergedItems = binding.preserveVerified && sameTask
		? items.map((item) => {
			const old = oldByIdentity.get(`${item.id}\u0000${item.requirement}\u0000${item.doneWhen}`);
			return old?.status === "verified" ? { ...item, status: "verified" as const, evidence: old.evidence } : item;
		})
		: items;
	const ledger: GoalLedger = {
		taskId: binding.taskId ?? previous.taskId,
		contractVersion: binding.contractVersion ?? previous.contractVersion,
		goal,
		items: mergedItems,
		updatedAt: new Date().toISOString(),
	};
	const target = file(workdir, scopeId);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, JSON.stringify(ledger, null, 2));
	return ledger;
}

export function verifyLedgerItem(workdir: string, id: string, evidence: string, scopeId?: string): GoalLedger | undefined {
	const ledger = loadGoalLedger(workdir, scopeId);
	const item = ledger.items.find((x) => x.id === id);
	if (!item) return undefined;
	item.status = "verified";
	item.evidence = evidence;
	return saveGoalLedger(workdir, ledger.goal, ledger.items, scopeId, { taskId: ledger.taskId, contractVersion: ledger.contractVersion });
}

export function goalLedgerBrief(ledger: GoalLedger): string {
	if (!ledger.items.length) return "【目标账本】尚未建立。";
	return `【目标账本——不可遗漏的完成门｜task=${ledger.taskId || "旧版"}｜v${ledger.contractVersion}】\n${ledger.items.map((item) => `${item.status === "verified" ? "✓" : item.status === "active" ? "→" : "○"} ${item.id}：${item.requirement}；完成=${item.doneWhen}${item.evidence ? `；证据=${item.evidence}` : ""}`).join("\n")}\n未核验项不允许宣布整体完成；合同版本变化后必须重建账本，内容未变化的已验证项会保留证据。`;
}
