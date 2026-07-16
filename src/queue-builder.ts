import { QueueStore } from "./queue-store.ts";
import type { TaskContract } from "./task-contract.ts";
import type { QueueContractSpec, QueueItemInput, QueueReviewPolicy } from "./queue-types.ts";

export interface AgentQueueItem {
	sourceKey: string;
	payload: unknown;
}

export interface AgentQueueSpec {
	title: string;
	itemPromptTemplate: string;
	items: AgentQueueItem[];
	reviewPolicy?: QueueReviewPolicy;
	parallelEnabled?: boolean;
	concurrency?: number;
	requireEvidence?: boolean;
	requireReadAfterWrite?: boolean;
	maxSemanticRedos?: number;
	maxTransientRetries?: number;
	itemTimeoutMs?: number;
}

export function queueContractFromTask(task: TaskContract, spec: AgentQueueSpec): QueueContractSpec {
	const primaryGoal = task.primaryGoal.trim() || task.latestRequest.trim();
	if (!primaryGoal) throw new Error("任务契约还没有主目标，不能创建队列");
	if (spec.itemPromptTemplate.trim().length < 12) throw new Error("每条记录的处理提示过短，必须写清动作和完成标准");
	if (!spec.items.length) throw new Error("队列至少需要一个 Item");
	if (spec.items.length > 10_000) throw new Error("单个队列最多 10000 个 Item，请拆批");
	const sourceKeys = new Set<string>();
	for (const item of spec.items) {
		if (!item.sourceKey.trim()) throw new Error("每个 Item 都必须有稳定 sourceKey");
		if (sourceKeys.has(item.sourceKey)) throw new Error(`sourceKey 重复：${item.sourceKey}`);
		sourceKeys.add(item.sourceKey);
	}
	const deterministicChecks = [{ id: "no-unresolved", type: "require-no-unresolved" }];
	if (spec.requireEvidence) deterministicChecks.push({ id: "evidence", type: "require-evidence" });
	if (spec.requireReadAfterWrite) deterministicChecks.push({ id: "read-after-write", type: "require-read-after-write" });
	return {
		primaryGoal,
		requirements: [
			...task.requirements,
			"每次只处理当前一条记录，不得把其它条目的输入或结论混入当前结果",
			"当前条目无法可靠完成时必须明确报告阻塞，不得猜测或虚构完成",
		],
		skills: task.referencedSkills.map((skill) => ({ name: skill.name, instructions: skill.instructions })),
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		itemPromptTemplate: spec.itemPromptTemplate.trim(),
		deterministicChecks,
		semanticReviewPolicy: spec.reviewPolicy ?? "when_needed",
		maxSemanticRedos: Math.max(0, Math.floor(spec.maxSemanticRedos ?? 1)),
		maxTransientRetries: Math.max(0, Math.floor(spec.maxTransientRetries ?? 4)),
		itemTimeoutMs: Math.max(0, Math.floor(spec.itemTimeoutMs ?? 0)),
	};
}

export function createAgentQueue(cwd: string, task: TaskContract, spec: AgentQueueSpec): QueueStore {
	const contract = queueContractFromTask(task, spec);
	const inputs: QueueItemInput[] = spec.items.map((item) => ({ sourceKey: item.sourceKey.trim(), payload: item.payload }));
	const configuredConcurrency = spec.parallelEnabled ? Math.max(2, Math.min(4, Math.floor(spec.concurrency ?? 2))) : 1;
	return QueueStore.create(cwd, contract, inputs, { title: spec.title.trim() || primaryTitle(task), configuredConcurrency });
}

function primaryTitle(task: TaskContract): string {
	return (task.primaryGoal || task.latestRequest || "批处理队列").replace(/\s+/g, " ").trim().slice(0, 48);
}
