import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type WorkItem = {
	id: string;
	title: string;
	objective: string;
	dependsOn: string[];
	doneWhen: string;
	status?: "pending" | "active" | "verified";
	evidence?: string;
};

export type ProgressivePlan = {
	taskId: string;
	contractVersion: number;
	goal: string;
	items: WorkItem[];
	currentId: string;
	updatedAt: string;
};

const EMPTY: ProgressivePlan = { taskId: "", contractVersion: 0, goal: "", items: [], currentId: "", updatedAt: "" };

function file(workdir: string, scopeId?: string): string {
	return scopeId
		? join(workdir, ".goal-mode-pi", "runs", scopeId, "progressive-plan.json")
		: join(workdir, ".goal-mode-pi", "progressive-plan.json");
}

/** 只把真正容易失控的“大任务”强制拆开；普通问答、小修不额外加手续。 */
export function needsWorkBreakdown(task: string): boolean {
	const t = task.trim();
	// “同一个动作 × 很多独立记录”属于 Queue，不属于阶段任务树；强行拆 2-8 阶段反而会丢记录。
	if (/(?:逐条|每条|批量|全量|几百|数百|上百).{0,40}(?:记录|数据|条目|行|产品|字段)|(?:记录|数据|条目|产品).{0,40}(?:逐条|每条|批量|全量|几百|数百|上百)/.test(t)) return false;
	if (t.length >= 120) return true;
	const broad = /完整|所有|全量|从零|端到端|一站式|系统|平台|项目|架构|调研|方案|多个|以及|并且|同时/g;
	return (t.match(broad) ?? []).length >= 2 || (/开发|搭建|重构|优化|实现/.test(t) && t.length >= 55);
}

export function loadProgressivePlan(workdir: string, scopeId?: string): ProgressivePlan {
	try {
		const saved = JSON.parse(readFileSync(file(workdir, scopeId), "utf8")) as Partial<ProgressivePlan>;
		return {
			...EMPTY,
			...saved,
			items: Array.isArray(saved.items) ? saved.items.map((item) => ({
				...item,
				status: item.status === "verified" ? "verified" : item.id === saved.currentId ? "active" : "pending",
				evidence: typeof item.evidence === "string" ? item.evidence : "",
			})) : [],
		};
	} catch {
		return { ...EMPTY };
	}
}

export function validateWorkPlan(goal: string, items: WorkItem[], currentId: string): string | undefined {
	if (items.length < 2 || items.length > 8) return "大任务必须拆成 2-8 个可独立验收的子任务，不能只换一种说法重复总目标。";
	const ids = new Set<string>();
	for (const item of items) {
		if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(item.id) || ids.has(item.id)) return "每个子任务必须有唯一、简短的 id。";
		ids.add(item.id);
		if (item.title.trim().length < 4 || item.objective.trim().length < 12 || item.doneWhen.trim().length < 12)
			return `子任务 ${item.id} 不够可执行：需要标题、明确目标和可观察的 done_when。`;
	}
	if (!ids.has(currentId)) return "current_id 必须指向本轮唯一先做的子任务。";
	for (const item of items) if (item.dependsOn.some((id) => !ids.has(id) || id === item.id)) return `子任务 ${item.id} 的依赖项不存在或指向自身。`;
	return undefined;
}

export function saveProgressivePlan(
	workdir: string,
	goal: string,
	items: WorkItem[],
	currentId: string,
	scopeId?: string,
	binding: { taskId?: string; contractVersion?: number } = {},
): ProgressivePlan {
	const previous = loadProgressivePlan(workdir, scopeId);
	const sameBinding = !!binding.taskId && previous.taskId === binding.taskId;
	const oldByIdentity = new Map(previous.items.map((item) => [`${item.id}\u0000${item.objective}\u0000${item.doneWhen}`, item]));
	const normalizedItems = items.map((item) => {
		const old = sameBinding ? oldByIdentity.get(`${item.id}\u0000${item.objective}\u0000${item.doneWhen}`) : undefined;
		if (old?.status === "verified") return { ...item, status: "verified" as const, evidence: old.evidence ?? "" };
		return { ...item, status: item.id === currentId ? "active" as const : "pending" as const, evidence: "" };
	});
	const plan: ProgressivePlan = {
		taskId: binding.taskId ?? "",
		contractVersion: binding.contractVersion ?? 0,
		goal,
		items: normalizedItems,
		currentId,
		updatedAt: new Date().toISOString(),
	};
	const target = file(workdir, scopeId);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, JSON.stringify(plan, null, 2));
	return plan;
}

/** 当前阶段只能由监督用证据核验；满足依赖后才允许把唯一 currentId 移到下一项。 */
export function verifyProgressiveWorkItem(
	workdir: string,
	id: string,
	evidence: string,
	nextId?: string,
	scopeId?: string,
): ProgressivePlan {
	const plan = loadProgressivePlan(workdir, scopeId);
	if (!plan.items.length) throw new Error("尚未建立渐进任务树");
	if (evidence.trim().length < 20) throw new Error("阶段证据太短；必须写清核查方法、结果以及如何满足 done_when");
	if (plan.currentId !== id) throw new Error(`只能核验当前阶段 ${plan.currentId || "（无）"}，不能跳过依赖或并行放行`);
	const current = plan.items.find((item) => item.id === id);
	if (!current || current.status !== "active") throw new Error("当前阶段状态无效，请按最新版合同重建任务树");
	current.status = "verified";
	current.evidence = evidence.trim();
	if (nextId) {
		const next = plan.items.find((item) => item.id === nextId);
		if (!next || next.status === "verified") throw new Error("next_id 不存在或已经完成");
		const verified = new Set(plan.items.filter((item) => item.status === "verified").map((item) => item.id));
		const missing = next.dependsOn.filter((dep) => !verified.has(dep));
		if (missing.length) throw new Error(`下一阶段 ${nextId} 的依赖尚未完成：${missing.join("、")}`);
		next.status = "active";
		plan.currentId = nextId;
	} else {
		const remaining = plan.items.filter((item) => item.status !== "verified");
		if (remaining.length) throw new Error(`还有未完成阶段：${remaining.map((item) => item.id).join("、")}；必须指定一个依赖已满足的 next_id`);
		plan.currentId = "";
	}
	plan.updatedAt = new Date().toISOString();
	const target = file(workdir, scopeId);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, JSON.stringify(plan, null, 2));
	return plan;
}

export function progressivePlanBrief(plan: ProgressivePlan): string {
	if (!plan.items.length) return "【渐进任务拆分】当前未建立任务树。";
	const rows = plan.items.map((item) => `${item.status === "verified" ? "✓" : item.id === plan.currentId ? "→" : "○"} ${item.id}：${item.title}；依赖=${item.dependsOn.join(",") || "无"}；验收=${item.doneWhen}${item.evidence ? `；证据=${item.evidence}` : ""}`).join("\n");
	return `【渐进任务拆分｜task=${plan.taskId || "旧版"}｜v${plan.contractVersion}】总目标：${plan.goal}\n${rows}\n纪律：本轮只能推进箭头所指的一项；它闭环后由监督逐项留证，再选择一个依赖已满足的相邻项。所有项出现 ✓ 前不得宣布整体完成；每项都先建立 1-5 变量的可复算最小模型。`;
}
