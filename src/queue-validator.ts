import type { QueueContract, QueueRunResult } from "./queue-types.ts";

export interface QueueValidationCheck {
	id: string;
	passed: boolean;
	message: string;
}

export interface QueueValidationReport {
	passed: boolean;
	needsSemanticReview: boolean;
	errors: string[];
	warnings: string[];
	checks: QueueValidationCheck[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function basicSchemaErrors(value: unknown, schema: Record<string, unknown>, path = "result"): string[] {
	const errors: string[] = [];
	const type = schema.type;
	if (type === "object") {
		if (!isObject(value)) return [`${path} 必须是 object`];
		for (const key of Array.isArray(schema.required) ? schema.required : []) {
			if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key} 缺失`);
		}
		if (isObject(schema.properties)) {
			for (const [key, childSchema] of Object.entries(schema.properties)) {
				if (key in value && isObject(childSchema)) errors.push(...basicSchemaErrors(value[key], childSchema, `${path}.${key}`));
			}
		}
	} else if (type === "array") {
		if (!Array.isArray(value)) return [`${path} 必须是 array`];
		if (isObject(schema.items)) value.forEach((entry, index) => errors.push(...basicSchemaErrors(entry, schema.items as Record<string, unknown>, `${path}[${index}]`)));
	} else if (type === "string" && typeof value !== "string") errors.push(`${path} 必须是 string`);
	else if (type === "number" && typeof value !== "number") errors.push(`${path} 必须是 number`);
	else if (type === "boolean" && typeof value !== "boolean") errors.push(`${path} 必须是 boolean`);
	return errors;
}

function shapeErrors(result: QueueRunResult): string[] {
	const errors: string[] = [];
	if (!result || typeof result !== "object") return ["结果不是对象"];
	if (!result.itemId) errors.push("itemId 缺失");
	if (!result.attemptId) errors.push("attemptId 缺失");
	if (!result.contractHash) errors.push("contractHash 缺失");
	if (!result.inputDigest) errors.push("inputDigest 缺失");
	if (!["changed", "no_change", "blocked"].includes(result.outcome)) errors.push("outcome 非法");
	for (const key of ["observations", "changes", "evidence", "unresolved", "skillUsage"] as const) {
		if (!Array.isArray(result[key])) errors.push(`${key} 必须是数组`);
	}
	return errors;
}

export function validateQueueRunResult(
	result: QueueRunResult,
	contract: QueueContract,
	expected: { itemId: string; attemptId: string; inputDigest: string },
): QueueValidationReport {
	const errors = shapeErrors(result);
	const warnings: string[] = [];
	const checks: QueueValidationCheck[] = [];
	const check = (id: string, passed: boolean, message: string) => {
		checks.push({ id, passed, message });
		if (!passed) errors.push(message);
	};

	check("identity", result.itemId === expected.itemId && result.attemptId === expected.attemptId, "Item 或 Attempt 身份不匹配");
	check("contract-hash", result.contractHash === contract.hash, "contractHash 不匹配");
	check("input-digest", result.inputDigest === expected.inputDigest, "inputDigest 不匹配");

	const usedSkills = new Map(Array.isArray(result.skillUsage) ? result.skillUsage.map((skill) => [skill.name, skill.sha256]) : []);
	for (const skill of contract.skills) check(`skill:${skill.name}`, usedSkills.get(skill.name) === skill.sha256, `Skill ${skill.name} 的哈希缺失或不匹配`);

	for (const schemaError of basicSchemaErrors(result, contract.outputSchema)) errors.push(schemaError);
	for (const spec of contract.deterministicChecks) {
		if (spec.type === "require-no-unresolved") {
			check(spec.id, result.unresolved.length === 0, "仍有 unresolved 项，不能验证通过");
		} else if (spec.type === "require-evidence") {
			check(spec.id, result.evidence.length > 0, "缺少证据，不能验证通过");
		} else if (spec.type === "require-read-after-write") {
			const needed = result.changes.length > 0;
			check(spec.id, !needed || result.writeback?.readAfterWritePassed === true, "有数据变更但缺少 read-after-write 成功证据");
		} else if (spec.type === "schema") {
			checks.push({ id: spec.id, passed: !errors.some((error) => error.includes("必须") || error.includes("缺失")), message: "基础 schema 检查" });
		} else {
			warnings.push(`未知确定性检查类型：${spec.type}`);
		}
	}

	if (result.outcome === "blocked") errors.push("执行端报告 blocked，需要人工或重试处理");
	const passed = errors.length === 0;
	const needsSemanticReview = passed && (
		contract.semanticReviewPolicy === "always" ||
		(contract.semanticReviewPolicy === "when_needed" && (result.outcome === "changed" || result.evidence.length > 0 || warnings.length > 0))
	);
	return { passed, needsSemanticReview, errors: [...new Set(errors)], warnings, checks };
}

export function classifyQueueError(error: unknown): { category: "rate_limit" | "auth" | "transient" | "validation" | "cancelled" | "unknown"; retryable: boolean; requestId?: string; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	const requestId = /request\s*id\s*[:：]\s*([\w-]+)/i.exec(message)?.[1];
	if (/\b429\b|requests are too frequent|rate.?limit/i.test(message)) return { category: "rate_limit", retryable: true, requestId, message };
	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key/i.test(message)) return { category: "auth", retryable: false, requestId, message };
	if (/abort|cancel|取消|中止/i.test(message)) return { category: "cancelled", retryable: true, requestId, message };
	if (/queue_result|schema|digest|hash|validation|验证|解析/i.test(message)) return { category: "validation", retryable: false, requestId, message };
	if (/timeout|timed out|econn|socket|network|temporar|\b5\d\d\b/i.test(message)) return { category: "transient", retryable: true, requestId, message };
	return { category: "unknown", retryable: false, requestId, message };
}
