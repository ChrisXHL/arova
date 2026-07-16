import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSharedCompactionCheckpoint, markCompactionParticipant, pendingSharedCompaction } from "./context-coordination.ts";
import { captureTaskContract, isContinuationOnly, isSupervisorDirective, loadTaskContract, normalizeUserTaskText, shouldStartNewTask, taskContractBrief, taskContractText, type TaskContract } from "./task-contract.ts";
import { loadProgressivePlan, needsWorkBreakdown, progressivePlanBrief, saveProgressivePlan, validateWorkPlan, type WorkItem } from "./progressive-plan.ts";
import { loadGoalLedger, needsGoalLedger, saveGoalLedger, validateGoalLedger, type GoalLedgerItem } from "./goal-ledger.ts";
import { createAgentQueue } from "./queue-builder.ts";
import { loadState } from "./state.ts";
import { isCurrentTaskLedger, loadTaskLedger, saveTaskLedger, validateRequirements, type AttemptOutcome, type BlockerKind, type EvidenceKind, type GapStatus } from "./task-ledger.ts";
import { freezeProblem, isProductBuildTask, loadProductRequirements, saveProductRequirements, validateProductRequirements, type ProductRequirement } from "./product-requirement-ledger.ts";
import { readerFacingContentContext, taskExecutionContext } from "./policy.ts";
import { contentVoiceProblem, isPublicCopyFile } from "./content-voice-guard.ts";
// Pi 没有从包根导出这个预检，但 ctx.compact 内部正是用它判断是否有可摘要内容。
// 提前压缩必须复用同一规则，不能只用 entries 数/字符数猜。
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

/**
 * 思维链插件——让"先想清楚再动手"成为【必然过程】，不是可选建议。
 *
 * 两件套：
 * 1. think_map 工具：摊开问题 → 选思维框架 → 关键假设逐条交叉验证。工具内部校验闭环
 *    （维度不够、假设没验证、敷衍——直接拒绝），通过才放行，并把图落盘到
 *    <cwd>/.goal-mode-pi/thinking/<时间>.md（监督和用户都能看）。
 * 2. tool_call 拦截：本任务还没通过 think_map 就想写大文档（write/edit 大内容）——
 *    工具层直接 block。这是结构性强制，不靠提示词自觉。
 *
 * 加载：pi --extension <此文件>（goal-mode 的两个执行端入口都会带上）。
 */

const DOC_RE = /\.(md|mdx|txt|rst|html|tex|doc\w*)$/i;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h)$/i;
const BIG_WRITE = 800; // write 文档内容超过这个字数 = 复杂产出，必须先有图
const BIG_EDIT = 600; // edit 新增文本超过这个字数 = 大改，同样拦
const NEW_TASK_LEN = 12; // 输入超过这个长度视为新任务 → 重置（中文一句任务约 15-30 字；"砍一半"这类短反馈不会误触）
const piHasCompactionWork = (entries: unknown[]): boolean => {
	try {
		return !!prepareCompaction(entries as never[], { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
	} catch {
		// 预检异常宁可等下一轮，也不能让压缩路径打断执行。
		return false;
	}
};

const BLOCK_MSG = `先别写——这是个复杂产出，思维链图还没画。
先调 think_map 工具把【论证】想清楚（不是列大纲）：
1. central：真正要解决的中心问题（用户为什么要这个？拿到手干嘛？）
2. conclusion：你要论证的核心结论——还没有结论就动笔，写出来的只是资料堆砌
3. branches：拆成哪几个维度，每个维度里什么是已知、什么是假设、什么是未知
4. framework：套哪个思维框架查漏（金字塔/第一性原理/目标-现状-差距…），为什么是它
5. verification：每条假设怎么交叉验证的（独立来源/反向推理/换视角），结果如何
6. logic：逻辑边——什么支撑结论、什么依赖什么、什么反驳什么。孤岛维度、被推翻的假设撑结论，都过不了
图闭环了，写起来又快又不用返工。小修小补不拦，大产出必须先有图。`;

const FOCUS_BLOCK_MSG = `先别动手——当前任务还没有“单点契约”。
先调 focus_step，建立一个 Minimum Viable Model：
- point：这轮唯一交付什么
- first_principle：决定结果的最底层因果
- variables：第一版只保留 1-5 个真正改变输出的变量
- calculation / output / baseline：最简单可复算规则、输出与对照基线
- done_when：看到什么事实才算闭环
- not_doing：明确把哪些诱人的范围推迟
- next_trigger：只有什么证据出现，才扩一个相邻点
全局只用来选点，不允许一上来铺成完整系统。`;

export default function thinkingChainExtension(pi: ExtensionAPI): void {
	const queueWorkerMode = process.env.GOAL_MODE_QUEUE_WORKER === "1";
	let thought = false; // 本任务是否已通过 think_map
	let focused = false; // 本任务是否已明确唯一执行点
	let currentFocus: Record<string, unknown> | undefined;
	let currentTaskContract: TaskContract;
	let currentTask = "";
	let previousTurnSettled = false;
	let compacting = false;
	let compactionTimer: ReturnType<typeof setTimeout> | undefined;
	let lastCompactionAttemptEntries = 0;
	let cwd = process.cwd();
	let scopeId = "";
	const ledgerIdentity = () => {
		const contract = currentTaskContract ?? loadTaskContract(cwd, scopeId);
		return { taskId: contract.taskId, contractVersion: contract.version, goal: contract.primaryGoal };
	};
	const scopedDir = (...parts: string[]) => scopeId
		? join(cwd, ".goal-mode-pi", "runs", scopeId, ...parts)
		: join(cwd, ".goal-mode-pi", ...parts);
	const writeSnapshot = (snapshot: Record<string, unknown>) => {
		try {
			const dir = scopedDir("thinking");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "latest.json"), JSON.stringify({ ...snapshot, focus: currentFocus, updatedAt: new Date().toISOString() }, null, 2));
		} catch {
			/* 可解释记录失败不能掀翻执行端 */
		}
	};
	const writeContextStatus = (status: Record<string, unknown>) => {
		try {
			const dir = scopedDir("context");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "latest.json"), JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
		} catch {
			/* 状态展示失败不影响执行 */
		}
	};
	const resolveSkillInstructions = (name: string): string | undefined => {
		try {
			const command = pi.getCommands().find((item) => item.source === "skill" && item.name === `skill:${name}`);
			const filePath = command?.sourceInfo.path;
			if (!filePath) return undefined;
			const content = readFileSync(filePath, "utf8");
			const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
			return `Skill location: ${filePath}\nReferences are relative to ${dirname(filePath)}.\n\n${body}`;
		} catch {
			// 宿主能力目录暂不可用时仍保留 skill 名，不影响用户当轮执行。
			return undefined;
		}
	};

	// 执行端也能写同一份账本；否则“遇阻换路径”的状态只停在监督提示里，无法跨上下文保留。
	pi.registerTool({
		name: "set_task_ledger", label: "Set Task Ledger",
		description: "为当前任务建立事实、假设、缺口、尝试路径和完成证据的持久账本。",
		parameters: Type.Object({ requirements: Type.Array(Type.Object({ id: Type.String(), description: Type.String() }), { minItems: 1 }), next_action: Type.String(), preserve_verified_context: Type.Optional(Type.Boolean()) }),
		execute: async (_id, params) => {
			const requirements = (params.requirements ?? []).map((item) => ({ id: item.id.trim(), description: item.description.trim() }));
			const error = validateRequirements(requirements); if (error) return { content: [{ type: "text" as const, text: `拒绝：${error}` }], details: {} };
			const identity = ledgerIdentity(), previous = loadTaskLedger(cwd, scopeId), carry = params.preserve_verified_context === true && previous.taskId === identity.taskId, evidenceById = new Map(previous.requirements.map((item) => [item.id, item.evidence]));
			saveTaskLedger(cwd, { ...identity, requirements: requirements.map((item) => ({ ...item, evidence: carry ? evidenceById.get(item.id) ?? "" : "" })), facts: carry ? previous.facts : [], hypotheses: carry ? previous.hypotheses : [], gaps: carry ? previous.gaps : [], attempts: carry ? previous.attempts : [], nextAction: params.next_action.trim() }, scopeId);
			return { content: [{ type: "text" as const, text: "task ledger 已建立；失败后必须记录新信息和不同的下一条路径。" }], details: {} };
		},
	});
	pi.registerTool({
		name: "set_product_requirement_ledger", label: "Set Product Requirement Ledger", description: "建立产品需求的证据、反证、指标、验收与非目标项；冻结前禁止编码。",
		parameters: Type.Object({ requirements: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), user_problem: Type.String(), hypothesis: Type.String(), evidence: Type.String(), counter_evidence: Type.String(), metric: Type.String(), acceptance: Type.String(), non_goal: Type.String() }), { minItems: 1 }) }),
		execute: async (_id, params) => {
			const requirements: ProductRequirement[] = (params.requirements ?? []).map((item) => ({ id: item.id.trim(), title: item.title.trim(), userProblem: item.user_problem.trim(), hypothesis: item.hypothesis.trim(), evidence: item.evidence.trim(), counterEvidence: item.counter_evidence.trim(), metric: item.metric.trim(), acceptance: item.acceptance.trim(), nonGoal: item.non_goal.trim() })); const error = validateProductRequirements(requirements); if (error) return { content: [{ type: "text" as const, text: `拒绝：${error}` }], details: {} };
			const identity = ledgerIdentity(); saveProductRequirements(cwd, { ...identity, requirements, frozen: false, frozenAt: "", freezeReason: "", implementations: [] }, scopeId); return { content: [{ type: "text" as const, text: "产品需求账本已建立；冻结前不能写代码。" }], details: {} };
		},
	});
	pi.registerTool({
		name: "freeze_product_requirements", label: "Freeze Product Requirements", description: "冻结已验证的产品需求，之后才能开始编码。",
		parameters: Type.Object({ reason: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadProductRequirements(cwd, scopeId), problem = freezeProblem(ledger, identity.taskId, identity.contractVersion); if (problem && !problem.includes("尚未冻结")) return { content: [{ type: "text" as const, text: `拒绝：${problem}` }], details: {} };
			if (params.reason.trim().length < 20) return { content: [{ type: "text" as const, text: "拒绝：冻结理由必须说明证据、反证和边界核查。" }], details: {} };
			ledger.frozen = true; ledger.frozenAt = new Date().toISOString(); ledger.freezeReason = params.reason.trim(); saveProductRequirements(cwd, ledger, scopeId); return { content: [{ type: "text" as const, text: "产品需求已冻结，可以开始编码。" }], details: {} };
		},
	});
	pi.registerTool({
		name: "link_requirement_implementation", label: "Link Requirement Implementation", description: "将冻结需求关联到代码与测试证据。",
		parameters: Type.Object({ requirement_id: Type.String(), code_evidence: Type.String(), test_evidence: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadProductRequirements(cwd, scopeId), problem = freezeProblem(ledger, identity.taskId, identity.contractVersion); if (problem) return { content: [{ type: "text" as const, text: `拒绝：${problem}` }], details: {} };
			if (!ledger.requirements.some((item) => item.id === params.requirement_id.trim())) return { content: [{ type: "text" as const, text: "拒绝：需求 id 不存在。" }], details: {} };
			ledger.implementations = ledger.implementations.filter((item) => item.requirementId !== params.requirement_id.trim()); ledger.implementations.push({ requirementId: params.requirement_id.trim(), codeEvidence: params.code_evidence.trim(), testEvidence: params.test_evidence.trim() }); saveProductRequirements(cwd, ledger, scopeId); return { content: [{ type: "text" as const, text: `需求 ${params.requirement_id} 已关联实现证据。` }], details: {} };
		},
	});
	pi.registerTool({
		name: "record_task_fact", label: "Record Task Fact", description: "记录有工具、文件、浏览器、URL、用户或运行结果支撑的事实。",
		parameters: Type.Object({ id: Type.String(), claim: Type.String(), evidence: Type.String(), kind: Type.Union([Type.Literal("tool"), Type.Literal("file"), Type.Literal("url"), Type.Literal("browser"), Type.Literal("user"), Type.Literal("runtime")]) }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadTaskLedger(cwd, scopeId); if (!isCurrentTaskLedger(ledger, identity.taskId, identity.contractVersion)) return { content: [{ type: "text" as const, text: "拒绝：先建立 task ledger。" }], details: {} };
			ledger.facts = ledger.facts.filter((item) => item.id !== params.id.trim()); ledger.facts.push({ id: params.id.trim(), claim: params.claim.trim(), evidence: params.evidence.trim(), kind: params.kind as EvidenceKind }); saveTaskLedger(cwd, ledger, scopeId);
			return { content: [{ type: "text" as const, text: `已记录事实：${params.id}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "record_task_hypothesis", label: "Record Task Hypothesis", description: "记录并更新尚未确定的判断，避免把猜测当结论。",
		parameters: Type.Object({ id: Type.String(), statement: Type.String(), status: Type.Union([Type.Literal("open"), Type.Literal("validated"), Type.Literal("rejected")]), evidence: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadTaskLedger(cwd, scopeId); if (!isCurrentTaskLedger(ledger, identity.taskId, identity.contractVersion)) return { content: [{ type: "text" as const, text: "拒绝：先建立 task ledger。" }], details: {} };
			ledger.hypotheses = ledger.hypotheses.filter((item) => item.id !== params.id.trim()); ledger.hypotheses.push({ id: params.id.trim(), statement: params.statement.trim(), status: params.status, evidence: params.evidence.trim() }); saveTaskLedger(cwd, ledger, scopeId);
			return { content: [{ type: "text" as const, text: `假设 ${params.id} = ${params.status}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "record_task_gap", label: "Record Task Gap", description: "记录并关闭关键缺口；关键缺口未关闭不能完成。",
		parameters: Type.Object({ id: Type.String(), question: Type.String(), critical: Type.Boolean(), status: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("blocked")]), resolution: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadTaskLedger(cwd, scopeId); if (!isCurrentTaskLedger(ledger, identity.taskId, identity.contractVersion)) return { content: [{ type: "text" as const, text: "拒绝：先建立 task ledger。" }], details: {} };
			ledger.gaps = ledger.gaps.filter((item) => item.id !== params.id.trim()); ledger.gaps.push({ id: params.id.trim(), question: params.question.trim(), critical: params.critical, status: params.status as GapStatus, resolution: params.resolution.trim() }); saveTaskLedger(cwd, ledger, scopeId);
			return { content: [{ type: "text" as const, text: `缺口 ${params.id} = ${params.status}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "record_task_attempt", label: "Record Task Attempt", description: "记录行动、阻塞分类、实际学到的东西和不同的下一步，避免原地重试。",
		parameters: Type.Object({ action: Type.String(), outcome: Type.Union([Type.Literal("success"), Type.Literal("no_new_evidence"), Type.Literal("blocked"), Type.Literal("failed")]), blocker: Type.Union([Type.Literal("none"), Type.Literal("access"), Type.Literal("missing_data"), Type.Literal("tool_failure"), Type.Literal("conflict"), Type.Literal("unknown")]), learned: Type.String(), next_action: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadTaskLedger(cwd, scopeId); if (!isCurrentTaskLedger(ledger, identity.taskId, identity.contractVersion)) return { content: [{ type: "text" as const, text: "拒绝：先建立 task ledger。" }], details: {} };
			if (params.outcome !== "success" && /^(重试|再试一次|继续尝试)$/i.test(params.next_action.trim())) return { content: [{ type: "text" as const, text: "拒绝：失败后必须换路径，不能原地重试。" }], details: {} };
			ledger.attempts.push({ action: params.action.trim(), outcome: params.outcome as AttemptOutcome, blocker: params.blocker as BlockerKind, learned: params.learned.trim(), nextAction: params.next_action.trim(), at: new Date().toISOString() }); ledger.nextAction = params.next_action.trim(); saveTaskLedger(cwd, ledger, scopeId);
			return { content: [{ type: "text" as const, text: `已记录尝试；下一步：${ledger.nextAction}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "verify_task_requirement", label: "Verify Task Requirement", description: "为任务要求写入可复查的完成证据。",
		parameters: Type.Object({ id: Type.String(), evidence: Type.String() }),
		execute: async (_id, params) => {
			const identity = ledgerIdentity(), ledger = loadTaskLedger(cwd, scopeId); if (!isCurrentTaskLedger(ledger, identity.taskId, identity.contractVersion)) return { content: [{ type: "text" as const, text: "拒绝：先建立 task ledger。" }], details: {} };
			const requirement = ledger.requirements.find((item) => item.id === params.id.trim()); if (!requirement) return { content: [{ type: "text" as const, text: "拒绝：requirement id 不存在。" }], details: {} };
			requirement.evidence = params.evidence.trim(); saveTaskLedger(cwd, ledger, scopeId); return { content: [{ type: "text" as const, text: `要求 ${requirement.id} 已核验。` }], details: {} };
		},
	});

	pi.on("session_start", (ev: unknown, ctx) => {
		const e = ev as { cwd?: string };
		if (e?.cwd) cwd = e.cwd;
		// 与宿主 spawnPiPty 的 sessionId 对齐：这里必须取 --session-dir 的目录名，
		// 不能取 JSONL 内部 UUID，否则服务端找不到该会话的思考快照。
		const sessionDir = ctx?.sessionManager?.getSessionDir?.() || "";
		scopeId = sessionDir ? basename(sessionDir) : "";
		currentTaskContract = loadTaskContract(cwd, scopeId);
	});

	// 真用户输入才更新合同。监督自动回灌是控制消息，不能污染用户要求、任务树或账本目标。
	pi.on("input", (ev: unknown) => {
		const e = ev as { text?: string };
		const t = (e?.text ?? "").trim();
		if (!t || isSupervisorDirective(t)) return undefined;
		const previousTaskId = currentTaskContract?.taskId;
		const previousVersion = currentTaskContract?.version ?? 0;
		const previousState = loadState({ workdir: cwd, scopeId });
		const normalizedInput = normalizeUserTaskText(t);
		const duplicateExpansion = currentTaskContract?.latestRequest === normalizedInput;
		const startNewTask = !duplicateExpansion && shouldStartNewTask(currentTaskContract ?? loadTaskContract(cwd, scopeId), t, {
			completed: previousState.completed,
			previousTurnSettled,
			progress: previousState.progress,
		});
		currentTaskContract = captureTaskContract(cwd, t, scopeId, {
			source: "user",
			// 不再只信监督的 completed：上一轮已交付后的独立动作句也必须切换 taskId。
			forceNewTask: startNewTask,
			forceRevision: previousState.completed && isContinuationOnly(t),
			resolveSkillInstructions,
		});
		previousTurnSettled = false;
		currentTask = currentTaskContract.primaryGoal;
		const contractChanged = currentTaskContract.taskId !== previousTaskId || currentTaskContract.version !== previousVersion;
		if (currentTaskContract.taskId !== previousTaskId || (contractChanged && t.length >= NEW_TASK_LEN)) {
			thought = false;
			focused = false;
			currentFocus = undefined;
			writeSnapshot({ status: "pending", task: currentTask, reason: "用户合同已更新，等待执行端按最新版要求重新确认单点和思维图。" });
		}
		const executionContext = taskExecutionContext(currentTask, cwd);
		return executionContext ? { action: "transform" as const, text: `${executionContext}\n\n【用户原始请求】\n${t}` } : undefined;
	});

	// 默认 pi 接近窗口上限才自动 compact；goal-mode 提前到 65%，用更小上下文换稳定速度。
	pi.on("agent_end", (_ev: unknown, ctx) => {
		previousTurnSettled = true;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent == null) return;
		writeContextStatus({ status: "active", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent });
		const threshold = Math.max(40, Math.min(85, Number(process.env.GOAL_MODE_COMPACT_PERCENT ?? 65)));
		// 压缩器只处理当前分支（getBranch），而 getEntries 会包含用户从历史节点
		// 分叉后放弃的所有旧对话。若拿全部分支估算，会把“旧分支很长、当前分支
		// 很短”误判为可压缩，最终触发 Nothing to compact 并打断当前工作。
		const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
		const historyChars = JSON.stringify(entries).length;
		const hasCompressibleHistory = entries.length >= 12 && historyChars >= 80_000 && entries.length >= lastCompactionAttemptEntries + 8;
		const coordinatedRequest = pendingSharedCompaction(cwd, "executor", scopeId);
		if ((usage.percent < threshold && !coordinatedRequest) || compacting || !hasCompressibleHistory) return;
		// 只要 Pi 自己认为没有可摘要的旧段，就绝不调用 ctx.compact；此前的
		// “Nothing to compact” 正是本层估算与 Pi 的切点规则不一致造成的。
		if (!piHasCompactionWork(entries)) {
			lastCompactionAttemptEntries = entries.length;
			if (coordinatedRequest) markCompactionParticipant(cwd, "executor", "skipped", coordinatedRequest, "当前分支没有可摘要的旧段，跳过压缩", scopeId);
			writeContextStatus({ status: "active", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, message: "当前上下文主要是保留段或固定提示，暂无可安全摘要的旧内容" });
			return;
		}
		compacting = true;
		lastCompactionAttemptEntries = entries.length;
		const checkpoint = coordinatedRequest ?? createSharedCompactionCheckpoint(cwd, "executor", scopeId);
		markCompactionParticipant(cwd, "executor", "waiting", checkpoint, "", scopeId);
		if (!coordinatedRequest) markCompactionParticipant(cwd, "supervisor", "requested", checkpoint, "执行端达到压缩阈值，请使用同一检查点同步上下文", scopeId);
		writeContextStatus({ status: "compacting", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent });
		const compactWhenIdle = (attempt = 0) => {
			// agent_end 监听器完成前，pi 仍处于当前 run。此时 compact 会间接 continue
			// 一个以 assistant 结尾的会话，触发 “Cannot continue from message role: assistant”。
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				if (attempt < 20) {
					compactionTimer = setTimeout(() => compactWhenIdle(attempt + 1), 150);
				} else {
					compacting = false;
					writeContextStatus({ status: "active", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, message: "当前仍有消息处理，等待下一轮空闲再压缩" });
				}
				return;
			}
			markCompactionParticipant(cwd, "executor", "compacting", checkpoint, "", scopeId);
			ctx.compact({
			customInstructions:
				`为 goal-mode 生成高保真工作摘要。执行端与监督端必须以这个共享检查点为同一事实源：${JSON.stringify(checkpoint)}。必须保留：最新用户真实目标与纠正；当前 Minimum Viable Model/单点契约 ${JSON.stringify(currentFocus ?? {})}；` +
				`用户偏好与不可牺牲约束；已验证事实和被推翻假设；关键决策及理由；修改/读取的文件；测试命令和结果；未完成事项与唯一下一步。\n\n${taskContractBrief(currentTaskContract ?? loadTaskContract(cwd, scopeId))}` +
				`\n删除：与上述任务契约无关的重复 skill 正文、原始工具长输出、已被替代的草稿、重复解释和与当前点无关的旧细节。不要把不确定内容总结成事实。`,
			onComplete: () => {
				compacting = false;
				markCompactionParticipant(cwd, "executor", "compacted", checkpoint, "", scopeId);
				writeContextStatus({ status: "compacted", percent: null, message: "上下文已压缩，关键工作状态已保留" });
			},
			onError: (error) => {
				compacting = false;
				markCompactionParticipant(cwd, "executor", /Nothing to compact|session too small/i.test(error.message) ? "skipped" : "error", checkpoint, error.message, scopeId);
				if (/Nothing to compact|session too small/i.test(error.message)) {
					writeContextStatus({ status: "active", tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent, message: "固定提示占用较高，当前消息历史还不需要压缩" });
				} else {
					writeContextStatus({ status: "error", percent: usage.percent, message: error.message });
				}
			},
			});
		};
		// 必须退出 agent_end 回调栈后再检查 idle；即使此刻报告 idle 也不能同步 compact。
		compactionTimer = setTimeout(() => compactWhenIdle(), 150);
	});

	pi.on("session_shutdown", () => {
		if (compactionTimer) clearTimeout(compactionTimer);
		compactionTimer = undefined;
		compacting = false;
	});

	// 结构性强制：没图，大文档写不出去
	pi.on("tool_call", (ev: unknown) => {
		const e = ev as { toolName?: string; input?: Record<string, unknown> };
		const input = e?.input ?? {};
		const path = String(input.path ?? input.file_path ?? input.filePath ?? "");
		if ((e?.toolName === "write" || e?.toolName === "edit") && !focused) {
			writeSnapshot({ status: "blocked", reason: "执行端准备修改文件，但还没有把任务砍成一个可闭环的点。", attemptedTool: e.toolName, attemptedPath: path });
			return { block: true, reason: FOCUS_BLOCK_MSG };
		}
		if ((e?.toolName === "write" || e?.toolName === "edit") && CODE_RE.test(path) && isProductBuildTask(currentTask)) {
			const identity = ledgerIdentity();
			const problem = freezeProblem(loadProductRequirements(cwd, scopeId), identity.taskId, identity.contractVersion);
			if (problem) {
				writeSnapshot({ status: "blocked", reason: `产品需求未冻结：${problem}`, attemptedTool: e.toolName, attemptedPath: path });
				return { block: true, reason: `先别写代码——${problem}\n\n先建立 set_product_requirement_ledger：每项需求必须有用户问题、假设、支持证据、反证、成功指标、验收标准和非目标项；再调 freeze_product_requirements。冻结后才能编码，并用 link_requirement_implementation 把每个需求关联到代码与测试证据。` };
			}
		}
		// 网站和面向读者的内容文件不能带出本应用的内部工作词。这里只拦截
		// 高置信度术语，不把“系统/流程”等正常产品词误判为问题。
		if ((e?.toolName === "write" || e?.toolName === "edit") && readerFacingContentContext(currentTask, cwd) && isPublicCopyFile(path)) {
			const content = String(e.toolName === "write" ? input.content ?? "" : input.newText ?? input.new_string ?? input.newStr ?? "");
			const problem = contentVoiceProblem(content);
			if (problem) {
				writeSnapshot({ status: "blocked", reason: problem, attemptedTool: e.toolName, attemptedPath: path });
				return { block: true, reason: `先别把内部工作语言写进用户页面——${problem}` };
			}
		}
		if (e?.toolName === "write") {
			const content = String(input.content ?? "");
			if (!thought && DOC_RE.test(path) && content.length >= BIG_WRITE) {
				writeSnapshot({ status: "blocked", reason: "准备写大文档，但当前任务还没有通过思维图校验。", attemptedTool: "write", attemptedPath: path });
				return { block: true, reason: BLOCK_MSG };
			}
		} else if (e?.toolName === "edit") {
			const next = String(input.newText ?? input.new_string ?? input.newStr ?? "");
			if (!thought && DOC_RE.test(path) && next.length >= BIG_EDIT) {
				writeSnapshot({ status: "blocked", reason: "准备大幅修改文档，但当前任务还没有通过思维图校验。", attemptedTool: "edit", attemptedPath: path });
				return { block: true, reason: BLOCK_MSG };
			}
		}
		return undefined;
	});

	pi.registerTool({
		name: "set_goal_ledger",
		label: "Set Goal Ledger",
		description: "多流程任务先建立不可遗漏的验收账本。逐项写用户目标和完成标准；监督会用同一账本逐项验收。",
		parameters: Type.Object({
			items: Type.Array(Type.Object({ id: Type.String(), requirement: Type.String(), done_when: Type.String() }), { minItems: 2 }),
		}),
			execute: async (_id, p) => {
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			const items: GoalLedgerItem[] = (p.items ?? []).map((item) => ({ id: item.id.trim(), requirement: item.requirement.trim(), doneWhen: item.done_when.trim(), status: "pending", evidence: "" }));
			const error = validateGoalLedger(items);
			if (error) return text(`拒绝：${error}`);
			saveGoalLedger(cwd, currentTaskContract.primaryGoal, items, scopeId, {
				taskId: currentTaskContract.taskId,
				contractVersion: currentTaskContract.version,
				preserveVerified: true,
			});
			return text("目标账本已建立。现在只推进第一项；其余项直到监督逐项核验前都不能被忘记或宣布完成。");
		},
	});

	pi.registerTool({
		name: "plan_work",
		label: "Plan Progressive Work",
		description: "大任务先拆成有依赖和验收标准的 2-8 个子任务，并只选一个 current_id。本工具只确定顺序；当前子任务仍必须再用 focus_step 建立 1-5 变量的量化模型。",
		parameters: Type.Object({
			items: Type.Array(Type.Object({
				id: Type.String(), title: Type.String(), objective: Type.String(), depends_on: Type.Array(Type.String()), done_when: Type.String(),
			}), { minItems: 2, maxItems: 8 }),
			current_id: Type.String(),
		}),
		execute: async (_id, p) => {
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			const items: WorkItem[] = (p.items ?? []).map((item) => ({ id: item.id.trim(), title: item.title.trim(), objective: item.objective.trim(), dependsOn: (item.depends_on ?? []).map((id) => id.trim()).filter(Boolean), doneWhen: item.done_when.trim() }));
			const currentId = (p.current_id ?? "").trim();
			const fullTask = taskContractText(currentTaskContract);
			const error = validateWorkPlan(fullTask, items, currentId);
			if (error) return text(`拒绝：${error}`);
			const plan = saveProgressivePlan(cwd, currentTaskContract.primaryGoal, items, currentId, scopeId, {
				taskId: currentTaskContract.taskId,
				contractVersion: currentTaskContract.version,
			});
			return text(`渐进任务树已锁定。\n${progressivePlanBrief(plan)}\n现在只对 ${currentId} 调 focus_step；不要并行开工其他项。`);
		},
	});

	if (!queueWorkerMode) pi.registerTool({
		name: "create_work_queue",
		label: "Create Work Queue",
		description: "当同一个处理动作要重复应用到几十/几百条独立记录时，把每条记录变成一个隔离 prompt。固定继承主目标、全部用户要求和引用 skill；可选并行子会话，队列由应用服务持续调度。不要用它拆有先后依赖的阶段。",
		parameters: Type.Object({
			title: Type.String({ description: "用户可识别的队列名称" }),
			item_prompt_template: Type.String({ description: "每一条都执行的固定动作和验收标准，可用 {{source_key}}、{{item_id}} 占位" }),
			items: Type.Array(Type.Object({
				source_key: Type.String({ description: "稳定、唯一的记录键" }),
				payload_json: Type.String({ description: "当前记录完整输入的 JSON object 字符串" }),
			}), { minItems: 1, maxItems: 10000 }),
			review_policy: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("when_needed"), Type.Literal("never")])),
			parallel_enabled: Type.Optional(Type.Boolean({ description: "是否开启 2-4 个独立子会话并发" })),
			concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
			require_evidence: Type.Optional(Type.Boolean()),
			require_read_after_write: Type.Optional(Type.Boolean()),
			max_semantic_redos: Type.Optional(Type.Number({ minimum: 0, description: "单条结构/证据不达标时自动重做次数" })),
			max_transient_retries: Type.Optional(Type.Number({ minimum: 0, description: "单条网络/5xx 重试次数；429 不消耗该预算" })),
			item_timeout_minutes: Type.Optional(Type.Number({ minimum: 0, description: "单条墙钟预算；0 或不填表示不限时" })),
			start_immediately: Type.Optional(Type.Boolean({ description: "应用服务在线时创建后立即运行；否则保留为待开始" })),
		}),
		execute: async (_id, p) => {
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			try {
				const items = (p.items ?? []).map((item) => {
					let payload: unknown;
					try { payload = JSON.parse(item.payload_json); }
					catch { throw new Error(`Item ${item.source_key} 的 payload_json 不是合法 JSON`); }
					if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`Item ${item.source_key} 的 payload_json 必须是 object`);
					return { sourceKey: item.source_key.trim(), payload };
				});
				const store = createAgentQueue(cwd, currentTaskContract ?? loadTaskContract(cwd, scopeId), {
					title: p.title,
					itemPromptTemplate: p.item_prompt_template,
					items,
					reviewPolicy: p.review_policy ?? "when_needed",
					parallelEnabled: p.parallel_enabled ?? false,
					concurrency: p.concurrency ?? 2,
					requireEvidence: p.require_evidence ?? false,
					requireReadAfterWrite: p.require_read_after_write ?? false,
					maxSemanticRedos: p.max_semantic_redos,
					maxTransientRetries: p.max_transient_retries,
					itemTimeoutMs: p.item_timeout_minutes == null ? 0 : Math.max(0, p.item_timeout_minutes * 60_000),
				});
				let started = false;
				if (p.start_immediately) {
					try {
						const port = Number(process.env.PORT ?? 5780);
						const response = await fetch(`http://127.0.0.1:${port}/queues/${store.queueId}/start?cwd=${encodeURIComponent(cwd)}`, {
							method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
						});
						started = response.ok;
					} catch { /* CLI 单独运行时没有应用服务；队列仍已耐久保存 */ }
				}
				const snapshot = store.getSnapshot();
				return text(`队列已创建：${snapshot.title}\nqueue_id=${store.queueId}\nItem=${snapshot.items.length}，并发=${snapshot.configuredConcurrency}，状态=${started ? "运行中" : "待开始"}。固定任务契约和 ${snapshot.items.length} 份输入已分别落盘；后续每个 worker 只会看到当前一条。${p.start_immediately && !started ? " 当前未连上应用调度服务，请在项目页点击“开始”。" : ""}`);
			} catch (error) {
				return text(`队列创建失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	pi.registerTool({
		name: "focus_step",
		label: "Focus One Point",
		description:
			"任何实质写入前先定一个单点闭环。只允许一个具体交付点；明确成功证据、暂不做范围，以及由真实证据触发的下一个相邻点。没有通过它，write/edit 会被工具层拦截。",
		parameters: Type.Object({
			point: Type.String({ description: "本轮唯一要做实的一个点，不是完整系统或模块列表" }),
			first_principle: Type.String({ description: "从第一性原理看，决定这个点成败的最底层因果" }),
			variables: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "第一版只保留 1-5 个真正改变输出的变量" }),
			calculation: Type.String({ description: "最简单、可由人复算的公式/评分/判定规则" }),
			output: Type.String({ description: "模型最终输出的分数、等级、选择或可验证结果" }),
			baseline: Type.String({ description: "最小基线、阈值或对照样本" }),
			done_when: Type.String({ description: "怎样观察或验证这个点已经闭环" }),
			not_doing: Type.Array(Type.String(), { minItems: 1, maxItems: 6, description: "明确推迟的范围" }),
			next_trigger: Type.String({ description: "什么真实反馈出现后，才值得扩一个相邻点" }),
		}),
		execute: async (_id, p) => {
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			const point = (p.point ?? "").trim();
			const firstPrinciple = (p.first_principle ?? "").trim();
			const variables = (p.variables ?? []).map((x) => x.trim()).filter(Boolean);
			const calculation = (p.calculation ?? "").trim();
			const output = (p.output ?? "").trim();
			const baseline = (p.baseline ?? "").trim();
			const doneWhen = (p.done_when ?? "").trim();
			const notDoing = (p.not_doing ?? []).map((x) => x.trim()).filter(Boolean);
			const nextTrigger = (p.next_trigger ?? "").trim();
			const fullTask = taskContractText(currentTaskContract);
			if (!queueWorkerMode && needsWorkBreakdown(fullTask)) {
				const plan = loadProgressivePlan(cwd, scopeId);
				if (!plan.items.length || plan.taskId !== currentTaskContract.taskId || plan.contractVersion !== currentTaskContract.version)
					return text("拒绝：这是大任务，但渐进计划不是当前合同版本。先调 plan_work 按最新版要求重建，再只选择第一项建立最小模型。");
			}
			if (!queueWorkerMode && needsGoalLedger(currentTaskContract, currentTask)) {
				const ledger = loadGoalLedger(cwd, scopeId);
				if (!ledger.items.length || ledger.taskId !== currentTaskContract.taskId || ledger.contractVersion !== currentTaskContract.version)
					return text("拒绝：这是多流程目标，但目标账本不是当前合同版本。先调 set_goal_ledger 覆盖最新版全部要求；未核验不能交付。");
			}
			const breadthSignals = point.match(/以及|同时|并且|全部|完整|一站式|端到端|全面/g) ?? [];
			if (point.length < 8 || point.length > 120 || breadthSignals.length >= 2)
				return text("拒绝：这个点仍然太大，像多个任务或一个完整系统。只留一个可独立交付的结果，其余放进 not_doing。");
			if (firstPrinciple.length < 15 || variables.length < 1 || variables.length > 5 || calculation.length < 12 || output.length < 6 || baseline.length < 10)
				return text("拒绝：Minimum Viable Model 不完整。用第一性原理找底层因果，只留 1-5 个变量，并写出可复算规则、输出和基线。第一版不许追求完美模型。");
			if (doneWhen.length < 12 || nextTrigger.length < 12 || notDoing.length < 1)
				return text("拒绝：单点契约不完整。必须有可观察的闭环条件、至少一个明确不做项、以及证据驱动的下一点触发条件。");
			currentFocus = { point, firstPrinciple, variables, calculation, output, baseline, doneWhen, notDoing, nextTrigger };
			focused = true;
			writeSnapshot({ status: thought ? "approved" : "focused", reason: "已锁定唯一执行点；复杂产出仍需 think_map 用全局分析证明为什么选它。" });
			return text(`最小可行模型已锁定：${point}\n第一性原理：${firstPrinciple}\n变量：${variables.join("、")}\n计算：${calculation}\n输出/基线：${output}｜${baseline}\n闭环：${doneWhen}\n这轮不做：${notDoing.join("；")}\n只有出现这条证据才增加复杂度：${nextTrigger}`);
		},
	});

	pi.registerTool({
		name: "think_map",
		label: "Think Map",
		description:
			"思维链图：复杂产出（写文档/方案/分析/架构/多步任务）动手之前必须先调它。这不是大纲，是【论证图】：节点（结论/维度/假设/未知）+ 类型化的逻辑边（支撑/反驳/依赖/导致）。校验的是逻辑本身——孤岛节点、被推翻的假设还在撑结论、结论没有支撑，都过不去。通过前写大文档会被工具层拦截；图落盘到 .goal-mode-pi/thinking/。",
		parameters: Type.Object({
			central: Type.String({ description: "中心问题：真正要解决的是什么（挖真实意图，不是抄任务原文）" }),
			conclusion: Type.String({ description: "这张图推出的核心结论/主张——正文要论证的那句话。还没有结论就别开写" }),
			branches: Type.Array(
				Type.Object({
					dimension: Type.String({ description: "子问题/维度名（短名词，之后 logic 边会引用它）" }),
					known: Type.Optional(Type.String({ description: "这个维度里的已知事实" })),
					assumptions: Type.Optional(Type.Array(Type.String({ description: "待验证的假设" }))),
					unknowns: Type.Optional(Type.String({ description: "完全不知道、要去查的" })),
				}),
				{ description: "问题拆解，至少 2 个维度" },
			),
			framework: Type.String({ description: "套用的思维框架 + 为什么选它 + 套上后发现补了什么漏" }),
			verification: Type.Array(
				Type.Object({
					assumption: Type.String({ description: "被验证的假设" }),
					method: Type.String({ description: "怎么交叉验证的：独立来源/反向推理/换视角，具体做了什么" }),
					result: Type.String({ description: "结论：站住了/推翻(图已改)/查不到(会写进产出局限)" }),
				}),
				{ description: "交叉验证记录。branches 里列了假设的，每条都要在这里出现" },
			),
			logic: Type.Array(
				Type.Object({
					from: Type.String({ description: "起点节点：写维度名/假设原文/「结论」" }),
					relation: Type.Union([Type.Literal("支撑"), Type.Literal("反驳"), Type.Literal("依赖"), Type.Literal("导致")], {
						description: "边的类型",
					}),
					to: Type.String({ description: "终点节点：写维度名/假设原文/「结论」" }),
				}),
				{ description: "逻辑边——图的灵魂。什么支撑结论？什么反驳什么？什么依赖什么？没有边的节点是孤岛，过不了校验" },
			),
		}),
		execute: async (_id, p) => {
			const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
			const reject = (reason: string) => {
				writeSnapshot({
					status: "rejected",
					reason,
					central: p.central,
					conclusion: p.conclusion,
					framework: p.framework,
					branches: p.branches,
					verification: p.verification,
					logic: p.logic,
				});
				return text(reason);
			};
			// —— 第一层：完整性校验（敷衍的图不放行） ——
			if ((p.central ?? "").trim().length < 8) return reject("拒绝：central 太敷衍。中心问题要写清'真正要解决什么、做成什么样算成'。");
			if ((p.conclusion ?? "").trim().length < 8) return reject("拒绝：conclusion 太敷衍。还没有结论就动笔，写出来的只能是资料堆砌。想清楚你要论证哪句话。");
			const branches = p.branches ?? [];
			if (branches.length < 2) return reject("拒绝：只有一个维度不叫拆解。复杂问题至少拆 2 个维度，想不出第二个说明还没想。");
			if ((p.framework ?? "").trim().length < 10) return reject("拒绝：framework 太敷衍。写清套了哪个框架、为什么、查出了什么漏。");
			const assumptions = branches.flatMap((b) => b.assumptions ?? []).map((a) => a.trim()).filter(Boolean);
			const verified = new Set((p.verification ?? []).map((v) => v.assumption.trim()));
			const missing = assumptions.filter((a) => ![...verified].some((v) => v.includes(a.slice(0, 12)) || a.includes(v.slice(0, 12))));
			if (missing.length) return reject(`拒绝：这些假设没有交叉验证记录，不许当成事实往下走：\n- ${missing.join("\n- ")}\n每条至少过一种验证（独立来源/反向推理/换视角），查不到就标"查不到"。`);
			for (const v of p.verification ?? []) {
				if (v.method.trim().length < 8 || v.result.trim().length < 4) return reject(`拒绝："${v.assumption}"的验证太敷衍（method/result 要写具体做了什么、结论是什么）。`);
			}
			// —— 第二层：逻辑校验（这才是图和大纲的区别） ——
			const logic = p.logic ?? [];
			if (!logic.length) return reject("拒绝：没有一条逻辑边。没有边的图是大纲不是论证——写清什么支撑结论、什么依赖什么、什么反驳什么。");
			// 节点解析：「结论」/ 维度名 / 假设原文（模糊匹配，前12字互含）
			type Node = { id: string; kind: "结论" | "维度" | "假设"; label: string };
			const nodes: Node[] = [{ id: "C", kind: "结论", label: p.conclusion }];
			branches.forEach((b, i) => nodes.push({ id: `D${i}`, kind: "维度", label: b.dimension }));
			assumptions.forEach((a, i) => nodes.push({ id: `A${i}`, kind: "假设", label: a }));
			const findNode = (ref: string): Node | undefined => {
				const r = ref.trim().replace(/^「|」$/g, "");
				if (/^结论$/.test(r)) return nodes[0];
				return nodes.find((n) => n.label === r) ?? nodes.find((n) => n.label.includes(r.slice(0, 12)) || r.includes(n.label.slice(0, 12)));
			};
			const badRefs: string[] = [];
			const edges: Array<{ from: Node; relation: string; to: Node }> = [];
			for (const e of logic) {
				const f = findNode(e.from);
				const t = findNode(e.to);
				if (!f || !t) badRefs.push(`${e.from} -${e.relation}-> ${e.to}`);
				else edges.push({ from: f, relation: e.relation, to: t });
			}
			if (badRefs.length)
				return reject(`拒绝：这些边的端点对不上任何节点（节点只能是「结论」、维度名、假设原文）：\n- ${badRefs.join("\n- ")}\n可用节点：${nodes.map((n) => n.label.slice(0, 20)).join("｜")}`);
			// 孤岛检查：每个维度必须至少挂一条边
			const touched = new Set(edges.flatMap((e) => [e.from.id, e.to.id]));
			const orphans = nodes.filter((n) => n.kind === "维度" && !touched.has(n.id));
			if (orphans.length)
				return reject(`拒绝：孤岛维度（和其它节点没有任何逻辑关系）：${orphans.map((o) => o.label).join("、")}。要么补上它和结论/其它维度的边，要么删掉它——不构成论证的维度不属于这张图。`);
			// 结论必须被支撑
			const supports = edges.filter((e) => e.relation === "支撑" && e.to.id === "C");
			if (supports.length < 2) return reject("拒绝：指向「结论」的支撑边少于 2 条。一条腿站不住论证——要么补论据，要么你的结论下早了。");
			// 被推翻的假设不许撑任何东西（自相矛盾检查）
			const verdictOf = (a: string) => {
				const v = (p.verification ?? []).find((x) => x.assumption.includes(a.slice(0, 12)) || a.includes(x.assumption.slice(0, 12)));
				return v ? (/推翻|不成立|错/.test(v.result) ? "❌" : /查不到|未知|存疑/.test(v.result) ? "❓" : "✅") : "";
			};
			const contradictions = edges.filter((e) => e.relation === "支撑" && e.from.kind === "假设" && verdictOf(e.from.label) === "❌");
			if (contradictions.length)
				return reject(`拒绝：自相矛盾——这些假设已被你自己的交叉验证【推翻】，却还在图里支撑别的节点：\n- ${contradictions.map((c) => c.from.label).join("\n- ")}\n删掉这些边，或者修改结论。被推翻的假设不能当论据。`);
			// —— 落盘（监督和用户都能看）：markdown 给人读改 + mermaid flowchart 呈现逻辑边 ——
			const mq = (s: string) => s.replace(/"/g, "'").slice(0, 46); // mermaid 节点文本转义+截断
			const lines: string[] = [
				`# 思维链图 · ${new Date().toISOString()}`,
				"",
				`**中心问题**：${p.central}`,
				"",
				`**结论**：${p.conclusion}`,
				"",
				`**框架**：${p.framework}`,
				"",
			];
			for (const b of branches) {
				lines.push(`- ${b.dimension}`);
				if (b.known) lines.push(`  - 已知：${b.known}`);
				for (const a of b.assumptions ?? []) lines.push(`  - 假设${verdictOf(a)}：${a}`);
				if (b.unknowns) lines.push(`  - 未知：${b.unknowns}`);
			}
			if ((p.verification ?? []).length) {
				lines.push("", "## 交叉验证");
				for (const v of p.verification ?? []) lines.push(`- ${v.assumption} → ${v.method} → ${v.result}`);
			}
			lines.push("", "## 逻辑关系");
			for (const e of edges) lines.push(`- ${e.from.label} —${e.relation}→ ${e.to.label}`);
			// flowchart：节点带类型，边带关系；被推翻/存疑的假设用样式标出来
			lines.push("", "```mermaid", "flowchart TD");
			lines.push(`  C{{"${mq(p.conclusion)}"}}`);
			for (const n of nodes) {
				if (n.kind === "维度") lines.push(`  ${n.id}["${mq(n.label)}"]`);
				else if (n.kind === "假设") lines.push(`  ${n.id}(["${mq(`${verdictOf(n.label)} ${n.label}`)}"])`);
			}
			const arrow = (rel: string) => (rel === "反驳" ? `-. ${rel} .->` : rel === "导致" ? `== ${rel} ==>` : `-- ${rel} -->`);
			for (const e of edges) lines.push(`  ${e.from.id} ${arrow(e.relation)} ${e.to.id}`);
			const bad = nodes.filter((n) => n.kind === "假设" && verdictOf(n.label) === "❌").map((n) => n.id);
			const iffy = nodes.filter((n) => n.kind === "假设" && verdictOf(n.label) === "❓").map((n) => n.id);
			lines.push("  classDef refuted stroke-dasharray: 5 5,opacity:0.55");
			lines.push("  classDef unknown stroke-dasharray: 2 2");
			if (bad.length) lines.push(`  class ${bad.join(",")} refuted`);
			if (iffy.length) lines.push(`  class ${iffy.join(",")} unknown`);
			lines.push("```");
			const timestamp = new Date().toISOString();
			try {
				const dir = scopedDir("thinking");
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, `${timestamp.replace(/[:.]/g, "-")}.md`), `${lines.join("\n")}\n`);
			} catch {
				/* 落盘失败不阻塞 */
			}
			writeSnapshot({
				status: "approved",
				central: p.central,
				conclusion: p.conclusion,
				framework: p.framework,
				branches: p.branches,
				verification: p.verification,
				logic: p.logic,
				checks: { supportingEdges: supports.length, assumptions: assumptions.length, contradictions: contradictions.length },
			});
			thought = true;
			return text(
				`逻辑闭环，放行：${supports.length} 条论据支撑结论，${assumptions.length} 条假设全部过验${contradictions.length === 0 ? "，无自相矛盾" : ""}。开始动手——正文沿着这张图展开：每条逻辑边就是一段论证，写完回头对照，不许长出图里没有的结论。`,
			);
		},
	});
}
