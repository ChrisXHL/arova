import type { QueueContract, QueueItem, QueueRunResult } from "./queue-types.ts";
import { sha256, stableJson } from "./queue-store.ts";

export const QUEUE_RESULT_OPEN = "<queue_result>";
export const QUEUE_RESULT_CLOSE = "</queue_result>";

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function queueExecutorSystemPrompt(contract: QueueContract): string {
	const requirements = contract.requirements.map((item) => `- ${item}`).join("\n") || "- （无额外要求）";
	const skills = contract.skills.map((skill) =>
		`<skill name="${skill.name}" sha256="${skill.sha256}">\n${skill.instructions}\n</skill>`,
	).join("\n\n") || "（无固定 Skill）";
	return `你是 goal-mode-pi 的队列执行 worker。你只处理当前一个 QueueItem，不拥有整批任务的完成权。\n\n` +
		`【不可变 QueueContract】\nqueue_id=${contract.queueId}\ncontract_version=${contract.version}\ncontract_hash=${contract.hash}\n` +
		`总目标：${contract.primaryGoal}\n用户要求：\n${requirements}\n\n` +
		`【本队列固定 Skill】\n${skills}\n\n` +
		`【执行纪律】\n` +
		`1. 只处理当前 Item，不能读取、推断或修改其他 Item。\n` +
		`2. 先用 1-5 个真正影响结果的变量建立可复算的最小判断，再执行。\n` +
		`3. 不确定内容放入 unresolved，禁止猜测。\n` +
		`4. 外部写入必须使用给定 idempotency key，并在写后重新读取验证。\n` +
		`5. 最终必须只在 ${QUEUE_RESULT_OPEN} 与 ${QUEUE_RESULT_CLOSE} 之间输出一个 JSON 对象；标签外可以有极短说明，但不能宣布整批任务完成。\n` +
		`6. 结果中的 contractHash、inputDigest、Skill 名称和哈希必须原样返回。\n` +
		`领域输出 schema：\n${json(contract.outputSchema)}`;
}

export function queueItemPrompt(contract: QueueContract, item: QueueItem, input: unknown, attemptId: string): string {
	const idempotencyKey = `${contract.queueId}:${item.id}:v${item.version + 1}`;
	const template = contract.itemPromptTemplate
		.replaceAll("{{queue_id}}", contract.queueId)
		.replaceAll("{{item_id}}", item.id)
		.replaceAll("{{source_key}}", item.sourceKey)
		.replaceAll("{{attempt_id}}", attemptId);
	const emptyResult: QueueRunResult = {
		itemId: item.id,
		attemptId,
		contractHash: contract.hash,
		inputDigest: item.inputDigest,
		outcome: "no_change",
		observations: [],
		changes: [],
		evidence: [],
		unresolved: [],
		skillUsage: contract.skills.map((skill) => ({ name: skill.name, sha256: skill.sha256 })),
	};
	return `【当前 QueueItem】\n` +
		`queue_id=${contract.queueId}\nitem_id=${item.id}\nattempt_id=${attemptId}\nsource_key=${item.sourceKey}\n` +
		`contract_hash=${contract.hash}\ninput_digest=${item.inputDigest}\nidempotency_key=${idempotencyKey}\n\n` +
		`【本条任务】\n${template}\n\n` +
		`${item.lastError ? `【上次尝试未通过】\n${item.lastError.message}\n请针对这个具体问题修正，不能重复同一错误。\n\n` : ""}` +
		`【当前输入】\n${json(input)}\n\n` +
		`【结果骨架】\n${QUEUE_RESULT_OPEN}\n${json(emptyResult)}\n${QUEUE_RESULT_CLOSE}\n\n` +
		`只处理这一条。若需要调用 Skill、接口或浏览器，仍必须把可核验证据写回结果。`;
}

export function queuePromptHash(systemPrompt: string, itemPrompt: string): string {
	return sha256(`${systemPrompt}\n\n${itemPrompt}`);
}

export function parseQueueRunResult(text: string): QueueRunResult {
	const tagged = text.match(/<queue_result>\s*([\s\S]*?)\s*<\/queue_result>/i)?.[1];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
	const source = tagged || fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	if (!source || !source.trim()) throw new Error("执行端没有返回 queue_result JSON");
	try {
		return JSON.parse(source) as QueueRunResult;
	} catch (error) {
		throw new Error(`queue_result JSON 无法解析：${String(error)}`);
	}
}

export function queueContractFingerprint(contract: QueueContract): string {
	return sha256(stableJson({ ...contract, hash: undefined }));
}
