import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capabilityDecisionBrief } from "./capability-catalog.ts";
import type { QueueContract, QueueItem, QueueReviewDecision, QueueRunResult } from "./queue-types.ts";
import type { QueueValidationReport } from "./queue-validator.ts";

export interface QueueReviewInput {
	contract: QueueContract;
	item: QueueItem;
	input: unknown;
	result: QueueRunResult;
	validation: QueueValidationReport;
}

export interface QueueReviewerLike {
	review(input: QueueReviewInput): Promise<QueueReviewDecision>;
}

export class QueueReviewer implements QueueReviewerLike {
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async review(input: QueueReviewInput): Promise<QueueReviewDecision> {
		let decision: QueueReviewDecision | undefined;
		const extension = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "submit_queue_review",
				label: "Submit Queue Review",
				description: "提交当前唯一 QueueItem 的独立验收结论。只能依据合同、当前输入、当前结果和校验报告。",
				parameters: Type.Object({
					verdict: Type.Union([Type.Literal("approved"), Type.Literal("redo"), Type.Literal("blocked")]),
					reason: Type.String(),
					evidence: Type.String(),
					redo_instruction: Type.Optional(Type.String()),
				}),
				execute: async (_id, params) => {
					const reason = params.reason.trim();
					const evidence = params.evidence.trim();
					const redoInstruction = params.redo_instruction?.trim();
					if (reason.length < 12 || evidence.length < 12) return { content: [{ type: "text" as const, text: "拒绝：reason 和 evidence 必须写清具体核查依据。" }], details: {} };
					if (params.verdict === "redo" && (!redoInstruction || redoInstruction.length < 12)) return { content: [{ type: "text" as const, text: "拒绝：redo 必须给出可执行的 redo_instruction。" }], details: {} };
					decision = { verdict: params.verdict, reason, evidence, ...(redoInstruction ? { redoInstruction } : {}) };
					return { content: [{ type: "text" as const, text: `已记录当前 Item 验收：${params.verdict}` }], details: {} };
				},
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: getAgentDir(),
			appendSystemPromptOverride: (base) => [
				...base,
				"你是队列条目监督。只核验当前一个 Item，不重新审整批目标，不读取其他 Item，不替执行端修改业务产出。必须调用 submit_queue_review 给出结构化结论。",
			],
			extensionFactories: [extension],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.cwd,
			resourceLoader,
			excludeTools: ["edit", "write"],
			sessionManager: SessionManager.inMemory(this.cwd),
		});
		try {
			const capabilities = capabilityDecisionBrief(resourceLoader.getSkills().skills.map((skill) => skill.name), session.getActiveToolNames());
			await session.prompt(
				`【QueueContract】\n${JSON.stringify(input.contract)}\n\n` +
				`【当前 Item】\n${JSON.stringify(input.item)}\n\n` +
				`【当前输入】\n${JSON.stringify(input.input)}\n\n` +
				`【执行结果】\n${JSON.stringify(input.result)}\n\n` +
				`【确定性校验】\n${JSON.stringify(input.validation)}\n\n` +
				`${capabilities}\n\n` +
				"检查结论是否由证据支持、变化是否符合当前合同、是否仍有猜测或来源冲突。只对这一条调用 submit_queue_review。",
			);
		} finally {
			session.dispose();
		}
		if (!decision) throw new Error("条目监督没有提交结构化结论");
		return decision;
	}
}

