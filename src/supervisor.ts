import { EventEmitter } from "node:events";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { classifyTask, corePolicy, domainBlock, humanVoicePolicy, outcomeFirstPolicy, responseLanguageInstruction, searchFallbackPolicy } from "./policy.ts";
import { loadState, saveState } from "./state.ts";
import { createSupervisorExtension } from "./supervisor-extension.ts";
import { loadSupervisorMemory, loadUserMemory } from "./supervisor-memory.ts";
import { supervisorSessionManager } from "./supervisor-history.ts";
import type { UIEvent } from "./ui-events.ts";
import { createSharedCompactionCheckpoint, markCompactionParticipant, pendingSharedCompaction, type SharedCompactionCheckpoint } from "./context-coordination.ts";
import { capabilityDecisionBrief } from "./capability-catalog.ts";
import { experiencePackText, retrieveExperiencePack } from "./experience-engine.ts";
import { captureTaskContract, isContinuationOnly, isStatusOnlyFollowup, isSupervisorDirective, loadTaskContract, normalizeUserTaskText, repairLegacyTaskBoundary, shouldStartNewTask, taskContractBrief, taskContractText } from "./task-contract.ts";
import { loadProgressivePlan, needsWorkBreakdown, progressivePlanBrief } from "./progressive-plan.ts";
import { goalLedgerBrief, loadGoalLedger, needsGoalLedger } from "./goal-ledger.ts";
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";

const piHasCompactionWork = (entries: unknown[]): boolean => {
	try {
		return !!prepareCompaction(entries as never[], { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
	} catch {
		return false;
	}
};

/**
 * 旁挂监督：自己是一个真 pi agent（带核查工具），只读地观察用户驱动的执行端。
 * 每当执行端结束一轮（由 SessionWatch 告知），review 一次；目标随用户对话进化。
 * 不驱动执行端——inject_directive 只在面板里给建议。
 */
export class Supervisor extends EventEmitter {
	private agent?: AgentSession;
	private state;
	private readonly provider: string;
	private active = false;
	private reviewing = false;
	private directives: string[] = []; // 本轮监督要回灌给执行端的重做指令
	private redoCount = 0;
	private compacting = false;
	private compactionTimer?: ReturnType<typeof setTimeout>;
	private lastCompactionAttemptEntries = 0;
	private runGeneration = 0;
	private promptGeneration = -1;
	private pendingCritique?: { text: string; generation: number };
	private pendingReview?: { text: string; generation: number };
	private drainingPending = false;
	private skipNextReview = false;
	private started = false;
	private agentInitializationSerial = 0;
	private capabilityBrief = "";
	private experienceBrief = "";
	private taskContractBrief(): string {
		return taskContractBrief(loadTaskContract(this.state.workdir, this.state.scopeId));
	}
	private workPlanBrief(): string {
		const plan = loadProgressivePlan(this.state.workdir, this.state.scopeId);
		if (plan.taskId !== this.state.taskId || plan.contractVersion !== this.state.contractVersion)
			return "【渐进任务拆分】当前任务尚未建立任务树；旧任务树已隔离，不得引用。";
		return progressivePlanBrief(plan);
	}
	private goalLedgerBrief(): string {
		const ledger = loadGoalLedger(this.state.workdir, this.state.scopeId);
		if (ledger.taskId !== this.state.taskId || ledger.contractVersion !== this.state.contractVersion)
			return "【目标账本】当前任务尚未建立账本；旧任务账本已隔离，不得引用。";
		return goalLedgerBrief(ledger);
	}
	/** 0 = 不按轮数停；用户可用 GOAL_MODE_MAX_REDOS 显式设置预算断路器。 */
	private readonly maxRedos: number;

	constructor(opts: { workdir: string; testCmd: string; provider?: string; scopeId?: string; maxRedos?: number }) {
		super();
		this.provider = opts.provider ?? "anthropic";
		const configuredMax = opts.maxRedos ?? Number(process.env.GOAL_MODE_MAX_REDOS ?? 0);
		this.maxRedos = Number.isFinite(configuredMax) ? Math.max(0, Math.floor(configuredMax)) : 0;
		this.state = loadState({ goal: "", workdir: opts.workdir, testCmd: opts.testCmd, scopeId: opts.scopeId });
		const previousTaskId = this.state.taskId;
		const contract = repairLegacyTaskBoundary(opts.workdir, opts.scopeId, {
			completed: this.state.completed,
			previousTurnSettled: this.state.executorTurnSettled,
			progress: this.state.progress,
		});
		if (contract.primaryGoal) {
			this.state.taskId = contract.taskId;
			this.state.contractVersion = contract.version;
			this.state.goal = contract.primaryGoal;
			this.state.latestRequest = contract.latestRequest;
			if (previousTaskId !== contract.taskId) {
				this.resetTaskScopedState(contract.taskId);
				this.state.workRevision = (this.state.workRevision ?? 0) + 1;
				this.state.lastTestPassed = false;
				this.state.lastTestRevision = -1;
			}
		}
	}

	private ui(e: UIEvent) {
		this.emit("ui", e);
	}
	private emitState() {
		this.ui({ kind: "state", state: { ...this.state } });
	}
	private resetTaskScopedState(taskId: string): void {
		this.state.trueIntent = "";
		this.state.reasoningAudit = {
			taskId,
			contractVersion: 0,
			goal: "",
			userValueFunction: "",
			hiddenAssumptions: "",
			blindSpots: "",
			disconfirmingEvidence: "",
			alternativePaths: "",
			failurePremortem: "",
			recommendation: "",
			verdict: "reframe",
		};
		this.state.focusContract = {
			taskId,
			contractVersion: 0,
			goal: "", point: "", firstPrinciple: "", variables: [], calculation: "", output: "", baseline: "",
			doneWhen: "", deferred: [], nextTrigger: "",
			status: "unset", evidence: "", decision: "unset",
		};
		this.state.progress = 0;
		this.state.findings = [];
		this.state.completed = false;
		this.state.executorTurnSettled = false;
	}

	async start(): Promise<void> {
		this.started = true;
		saveState(this.state);
		this.emitState();
		const serial = ++this.agentInitializationSerial;
		await this.initializeAgentForTask(this.state.taskId, serial, false);
	}

	/** 每个 taskId 使用独立的监督模型会话与任务记忆；同一可见会话内换任务也不会继承旧监督推理。 */
	private async initializeAgentForTask(expectedTaskId: string, serial: number, replacing: boolean): Promise<void> {
		if (!this.started || serial !== this.agentInitializationSerial) return;
		const onSuggest = (message: string, urgent: boolean) => {
			this.ui({ kind: "supervisor", sub: "suggest", text: (urgent ? "⚠ " : "") + message });
			this.directives.push(message); // 攒起来，本轮 review 结束后自动回灌给执行端
		};
		// 任务记忆按执行 session + taskId 双重隔离；同一聊天里的上一个任务也不能污染新任务。
		const memory = loadSupervisorMemory(this.state.workdir, this.state.scopeId, expectedTaskId);
		const userMemory = loadUserMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.state.workdir,
			agentDir: getAgentDir(),
			// 不覆盖 pi 默认系统提示——那才是让它"成为一个能干 agent"的大脑；
			// 只在其后【追加】监督角色。这样监督端是完整的 pi agent + 监督职责，而不是被换成一段便利贴。
			// 系统提示只放 core（人格与纪律）；领域规则按任务类型在每轮验收时现注入，遵循率更高
			appendSystemPromptOverride: (base) => [
				...base,
				corePolicy(),
				...(userMemory ? [`【关于这个用户的跨项目长期记忆——优先用于理解其利益函数、偏好和底线】\n${userMemory}`] : []),
				...(memory ? [`【当前会话已验证的记忆——仅限本任务，判断时直接用】\n${memory}`] : []),
			],
			extensionFactories: [createSupervisorExtension(this.state, onSuggest, () => this.promptGeneration === this.runGeneration)],
		});
		await resourceLoader.reload();
		if (!this.started || serial !== this.agentInitializationSerial || expectedTaskId !== this.state.taskId) return;
		const { session } = await createAgentSession({
			cwd: this.state.workdir,
			resourceLoader,
			// 监督是【完整的 pi】，拥有 pi 全部能力：read/bash/edit/write + 发现到的所有 skill + extension + memory。
			// 不再 excludeTools——靠策略保持它"评估者"身份，而不是靠阉割工具。这样才能最大释放价值。
			sessionManager: supervisorSessionManager(this.state.workdir, this.state.scopeId, expectedTaskId),
		});
		if (!this.started || serial !== this.agentInitializationSerial || expectedTaskId !== this.state.taskId) {
			session.dispose();
			return;
		}
		this.agent = session;
		// 不只让 Pi 在系统提示中静态列出能力；把本次真正已激活的工具和关键 skill
		// 摘要带进每次决策提示，迫使监督在选择路径时把 workflow/computer use 纳入比较。
		this.capabilityBrief = capabilityDecisionBrief(
			resourceLoader.getSkills().skills.map((skill) => skill.name),
			session.getActiveToolNames(),
		);
		this.experienceBrief = experiencePackText(retrieveExperiencePack(this.state.workdir, `${this.state.goal}\n${this.state.latestRequest}`));
		this.agent.subscribe((event) => this.onAgentEvent(event));
		this.ui({
			kind: "log",
			level: "info",
			text:
				replacing
					? "已切换到独立监督上下文，旧任务计划、记忆和指令均已隔离"
					: userMemory || memory
					? `监督已就绪，带着${userMemory ? "用户长期记忆" : ""}${userMemory && memory ? "和" : ""}${memory ? "项目记忆" : ""}`
					: "监督已就绪，旁挂在执行端旁边",
		});
		void this.drainPendingWork();
	}

	private replaceAgentForTask(taskId: string): void {
		const serial = ++this.agentInitializationSerial;
		const previous = this.agent;
		this.agent = undefined;
		void (async () => {
			if (previous) {
				if (previous.isStreaming) await previous.abort().catch(() => undefined);
				previous.dispose();
			}
			await this.initializeAgentForTask(taskId, serial, true);
		})().catch((error) => {
			if (serial === this.agentInitializationSerial)
				this.ui({ kind: "log", level: "warn", text: `新任务监督上下文初始化失败，执行端仍可继续：${String(error).slice(0, 160)}` });
		});
	}

	private onAgentEvent(event: unknown) {
		const e = event as {
			type: string;
			toolName?: string;
			assistantMessageEvent?: { type: string; delta?: string };
			message?: { role?: string; stopReason?: string; errorMessage?: string };
		};
		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			this.ui({ kind: "supervisor", sub: "text", text: e.assistantMessageEvent.delta ?? "" });
		} else if (e.type.includes("tool_call") && e.toolName) {
			this.ui({ kind: "supervisor", sub: "tool", text: e.toolName });
		} else if (e.type.includes("tool_result")) {
			this.ui({ kind: "supervisor", sub: "tool-result", text: e.toolName ?? "" });
			this.emitState();
		} else if (e.type === "message_end" && e.message?.role === "assistant" && e.message?.stopReason === "error") {
			// 模型调用失败绝不能静默——否则用户看到"看看这轮做得咋样"后就没下文了
			this.ui({ kind: "log", level: "warn", text: `监督这轮没跑成：${e.message.errorMessage || "模型调用出错"}` });
		} else if (e.type === "agent_end" && this.agent && !this.compacting) {
				const usage = this.agent.getContextUsage();
				// 必须和 Pi 的实际压缩范围一致：只看当前分支。getEntries 包含被放弃的
				// 历史分支，会造成“看起来很长、实际没有可压缩内容”的假触发。
				const entries = this.agent.sessionManager.getBranch();
				// contextUsage 包含不可压缩的系统提示/工具 schema。只有消息历史本身足够大且比上次尝试多出一批，才 compact。
				const historyChars = JSON.stringify(entries).length;
				const hasCompressibleHistory = entries.length >= 12 && historyChars >= 80_000 && entries.length >= this.lastCompactionAttemptEntries + 8;
				const coordinatedRequest = pendingSharedCompaction(this.state.workdir, "supervisor", this.state.scopeId);
				const piCanCompact = piHasCompactionWork(entries);
				if (usage?.percent != null && (usage.percent >= Number(process.env.GOAL_MODE_SUPERVISOR_COMPACT_PERCENT ?? 65) || coordinatedRequest) && hasCompressibleHistory && piCanCompact) {
					this.compacting = true;
					this.lastCompactionAttemptEntries = entries.length;
					this.ui({ kind: "log", level: "info", text: `监督上下文 ${usage.percent.toFixed(0)}%，等待空闲后压缩旧信息` });
					const checkpoint = coordinatedRequest ?? createSharedCompactionCheckpoint(this.state.workdir, "supervisor", this.state.scopeId);
					markCompactionParticipant(this.state.workdir, "supervisor", "waiting", checkpoint, "", this.state.scopeId);
					if (!coordinatedRequest) markCompactionParticipant(this.state.workdir, "executor", "requested", checkpoint, "监督端达到压缩阈值，请使用同一检查点同步上下文", this.state.scopeId);
					this.compactSupervisorWhenIdle(usage.percent, checkpoint);
				}
		}
	}

	private compactSupervisorWhenIdle(percent: number, checkpoint: SharedCompactionCheckpoint, attempt = 0): void {
		this.compactionTimer = setTimeout(() => {
			if (!this.agent) {
				this.compacting = false;
				return;
			}
			// agent_end 发布时 session 可能仍在收尾；退出事件栈并确认停止 streaming 后才 compact。
			if (this.agent.isStreaming || this.reviewing) {
				if (attempt < 20) this.compactSupervisorWhenIdle(percent, checkpoint, attempt + 1);
				else this.compacting = false;
				return;
			}
			markCompactionParticipant(this.state.workdir, "supervisor", "compacting", checkpoint, "", this.state.scopeId);
			void this.agent
					.compact(
						`监督端与执行端必须以这个共享检查点为同一事实源：${JSON.stringify(checkpoint)}。保留：用户最新目标与真实意图；用户长期偏好；当前认知审计；当前 Minimum Viable Model/单点契约 ${JSON.stringify(this.state.focusContract)}；` +
						`已核实事实、反证、关键决策、改动文件、测试证据、未解决问题和唯一下一步。删除重复工具输出、skill 正文、已过期草稿和重复讨论。`,
					)
					.then(() => {
						markCompactionParticipant(this.state.workdir, "supervisor", "compacted", checkpoint, "", this.state.scopeId);
						this.ui({ kind: "log", level: "info", text: "监督旧上下文已压缩，已与执行端共享检查点对齐" });
					})
					.catch((err) => {
						const message = String(err);
						// 固定系统提示占比高、消息历史仍太小时是正常状态，不应吓用户或每轮重试。
						if (!/Nothing to compact|session too small/i.test(message))
							this.ui({ kind: "log", level: "warn", text: `监督上下文压缩失败：${message.slice(0, 120)}` });
						markCompactionParticipant(this.state.workdir, "supervisor", /Nothing to compact|session too small/i.test(message) ? "skipped" : "error", checkpoint, message.slice(0, 200), this.state.scopeId);
					})
					.finally(() => (this.compacting = false));
		}, 150);
	}

	/** 真用户输入更新合同；普通补充强化同一主目标，只有显式“新任务”才切 taskId。 */
	onUserTask(text: string): void {
		const t = text.trim();
		if (!t || isSupervisorDirective(t)) return;
		const normalized = normalizeUserTaskText(t);
		const statusOnly = isStatusOnlyFollowup(t);

		const previousTaskId = this.state.taskId;
		const previousVersion = this.state.contractVersion;
		const beforeCapture = loadTaskContract(this.state.workdir, this.state.scopeId);
		// 执行端 extension 通常会先记录同一条输入；若已记录就直接复用，不能再生成第二个 taskId。
		const capturedUpstream = beforeCapture.latestRequest === normalized &&
			(beforeCapture.taskId !== previousTaskId || beforeCapture.version !== previousVersion);
		const shouldStartFresh = beforeCapture.taskId === previousTaskId && shouldStartNewTask(
			{ ...beforeCapture, primaryGoal: this.state.goal || beforeCapture.primaryGoal, latestRequest: this.state.latestRequest },
			t,
			{ completed: this.state.completed, previousTurnSettled: this.state.executorTurnSettled, progress: this.state.progress },
		);
		const contract = captureTaskContract(this.state.workdir, t, this.state.scopeId, {
			source: "user",
			// 若执行端 extension 已正确切到新 taskId，直接复用；若它只追加了旧合同，监督在这里兜底纠正。
			forceNewTask: shouldStartFresh && (!capturedUpstream || beforeCapture.taskId === previousTaskId),
			forceRevision: this.state.completed && isContinuationOnly(t),
		});
		const taskChanged = previousTaskId !== contract.taskId;
		const contractChanged = taskChanged || previousVersion !== contract.version;

		// 每次真用户输入都开启新的监督代际。旧 critique/review 即使稍后返回，也没有权限修改新状态。
		this.runGeneration++;
		this.promptGeneration = -1;
		this.directives = [];
		if (this.agent?.isStreaming) void this.agent.abort().catch(() => undefined);

		this.state.taskId = contract.taskId;
		this.state.contractVersion = contract.version;
		this.state.goal = contract.primaryGoal || normalized;
		this.state.latestRequest = normalized;
		this.state.executorTurnSettled = false;
		if (statusOnly) {
			// 状态询问由执行端直接回答；不重开审目标、不让监督拿旧计划评价这条回答。
			this.skipNextReview = true;
			saveState(this.state);
			this.emitState();
			this.ui({ kind: "supervisor", sub: "turn", text: `状态询问：${normalized.slice(0, 40)}（不改变当前任务）` });
			return;
		}
		this.skipNextReview = false;
		if (taskChanged) {
			this.resetTaskScopedState(contract.taskId);
		}
		this.state.completed = false;
		if (contractChanged) {
			this.state.workRevision = (this.state.workRevision ?? 0) + 1;
			this.state.lastTestPassed = false;
			this.state.lastTestRevision = -1;
			this.redoCount = 0;
		}
		this.active = true;
		saveState(this.state);
		this.emitState();
		this.ui({ kind: "supervisor", sub: "turn", text: `主目标：${this.state.goal.slice(0, 40)}${t !== this.state.goal ? `｜补充：${t.slice(0, 32)}` : ""}` });
		this.pendingCritique = { text: t, generation: this.runGeneration };
		if (taskChanged && this.started) this.replaceAgentForTask(contract.taskId);
		else void this.drainPendingWork();
	}

	/** SessionWatch/测试在执行端交付最终回复后标记；新动作不再依赖 mark_complete 才能切任务。 */
	noteExecutorTurnSettled(): void {
		this.state.executorTurnSettled = true;
		saveState(this.state);
	}

	/** 执行端被用户取消时，监督必须中止同一轮，且取消后的结果/指令一律作废。 */
	cancelCurrent(reason = "执行端已取消生成"): void {
		this.runGeneration++;
		this.promptGeneration = -1;
		this.directives = [];
		this.pendingCritique = undefined;
		this.pendingReview = undefined;
		if (this.compactionTimer) clearTimeout(this.compactionTimer);
		this.compactionTimer = undefined;
		this.compacting = false;
		this.state.executorTurnSettled = true;
		saveState(this.state);
		if (this.agent?.isStreaming) void this.agent.abort().catch(() => undefined);
		this.ui({ kind: "log", level: "info", text: `执行端已取消，监督同步停止：${reason}` });
	}

	/** 评估/测试用：直接设定目标与真实意图，不触发目标审查（critiqueGoal），只测验收环节。 */
	primeGoal(goal: string, trueIntent = ""): void {
		this.state.taskId = this.state.taskId || "task-test";
		this.state.contractVersion = this.state.contractVersion || 1;
		this.state.goal = goal;
		this.state.latestRequest = goal;
		this.state.trueIntent = trueIntent;
		this.state.reasoningAudit = {
			taskId: this.state.taskId,
			contractVersion: 0,
			goal: "",
			userValueFunction: "",
			hiddenAssumptions: "",
			blindSpots: "",
			disconfirmingEvidence: "",
			alternativePaths: "",
			failurePremortem: "",
			recommendation: "",
			verdict: "reframe",
		};
		this.state.focusContract = {
			taskId: this.state.taskId,
			contractVersion: 0,
			goal: "", point: "", firstPrinciple: "", variables: [], calculation: "", output: "", baseline: "",
			doneWhen: "", deferred: [], nextTrigger: "",
			status: "unset", evidence: "", decision: "unset",
		};
		this.state.completed = false;
		this.state.executorTurnSettled = false;
		this.state.lastTestPassed = false;
		this.state.lastTestRevision = -1;
		this.active = true;
		this.redoCount = 0;
		this.directives = [];
		saveState(this.state);
	}

	/** 串行消费监督工作：启动未就绪、上一轮仍在退出时都先排队，绝不丢首轮或并发串线。 */
	private async drainPendingWork(): Promise<void> {
		if (this.drainingPending || !this.agent) return;
		this.drainingPending = true;
		try {
			while (this.agent) {
				if (this.pendingCritique) {
					const pending = this.pendingCritique;
					this.pendingCritique = undefined;
					if (pending.generation !== this.runGeneration) continue;
					await this.critiqueGoal(pending.text, pending.generation);
					continue;
				}
				if (this.pendingReview) {
					const pending = this.pendingReview;
					this.pendingReview = undefined;
					if (pending.generation !== this.runGeneration) continue;
					await this.performReview(pending.text, pending.generation);
					continue;
				}
				break;
			}
		} finally {
			this.drainingPending = false;
			if ((this.pendingCritique || this.pendingReview) && this.agent) void this.drainPendingWork();
		}
	}

	/** 目标一到先审目标——目标错了，后面验收再严都是帮用户高效地走错路。 */
	private async critiqueGoal(latestRequest: string, generation: number): Promise<void> {
		if (!this.agent || generation !== this.runGeneration) return;
		this.promptGeneration = generation;
		this.ui({ kind: "supervisor", sub: "turn", text: "先看看这目标靠不靠谱" });
		const block = domainBlock(classifyTask(`${this.state.goal}\n${latestRequest}`, this.state.workdir));
		const currentContract = loadTaskContract(this.state.workdir, this.state.scopeId);
		const fullTask = taskContractText(currentContract, this.state.goal);
		try {
			await this.agent.prompt(
					`[稳定主目标] ${this.state.goal}\n[用户本轮补充] ${latestRequest}\n` +
					this.taskContractBrief() + "\n\n" +
					this.workPlanBrief() + "\n\n" +
					this.goalLedgerBrief() + "\n\n" +
					this.capabilityBrief + "\n\n" +
					`【当前任务可用经验包——只作先验，必须按边界重新取证】\n${this.experienceBrief}\n\n` +
					block +
						`\n` +
						`执行端刚开始干，先别验收。你现在不是需求复述器：要搞清真实意图，并主动找出用户自己可能没发现的思考漏洞。\n` +
						outcomeFirstPolicy("supervisor") + "\n\n" +
						searchFallbackPolicy("supervisor") + "\n\n" +
						`第一步——推断真实意图（他说的话是表面，你要挖下面那层）：\n` +
						`- 他为什么现在提这个？拿到结果他要干什么？什么样的结果他会说"对，就是这个"？\n` +
						`- 他要的 X 是不是更大问题的一个表面症状（XY 问题）？\n` +
						`- 不了解项目就去看：读 README、代码、git log、.goal-mode-pi/loop-log.md。\n` +
						`- 上面若有【专项】模块，审目标时就按它调研（比如产品类先找 2-3 个标杆真拆，把标配清单+及格线写进真实意图）。\n` +
						`推断完【必须调 set_true_intent 写下来】——之后所有验收都对照它，不对照字面目标。\n` +
						`紧接着必须调 set_task_ledger：把最终要证明的要求拆开，定义当前最小行动。之后把已证实事实、未验证假设、关键缺口、每次失败的阻塞和不同下一步、每项要求的完成证据持续记入账本。它是跨上下文的真实工作记忆，不是形式化清单。\n` +
						`第二步——做【认知红队】，而不是顺着用户论证：\n` +
						`- 先定义用户利益函数：这单真正要最大化什么？哪些底线不能拿去交换？把时间、钱、风险、可逆性、机会成本、长期复利都算进去。\n` +
						`- 隐藏假设：这件事成立依赖哪些没有被证明的前提？哪个最脆弱？\n` +
						`- 盲区：遗漏了谁、什么约束、二阶影响、机会成本或指标被做假的可能？\n` +
						`- 反证：主动找什么事实会证明用户的方向是错的；不要只搜支持材料。\n` +
						`- 替代路径：至少提出一条机制不同的做法，比较成本、可逆性和失败代价。\n` +
						`- 失败预演：假设三个月后失败了，最可能不是执行问题，而是哪项判断今天就错了？\n` +
						`- 明确拍板：站在用户一边选净收益最高的方案，写清“建议做什么/不做什么/为什么”。禁止用“各有利弊、取决于你”逃避判断。\n` +
						`完成后【必须调 set_reasoning_audit】留下结构化审计。没有实质发现也要写清查了什么，禁止用套话凑数。\n` +
						`第三步——判方向：proceed 才继续原目标；reframe/stop 就用 inject_directive 立即纠偏。质疑必须有项目事实或外部证据，不为反对而反对。\n` +
						`${needsGoalLedger(currentContract, this.state.goal) ? "第四步——这是多流程目标：先调 set_goal_ledger，把每个用户目标/流程写成独立验收项；后续必须逐项 verify_goal_item，未核验项绝不能 mark_complete。\n" : ""}${needsWorkBreakdown(fullTask) ? "第五步——这是大任务：必须先调 set_work_plan，把目标拆成 2-8 个有依赖和验收条件的子任务，只选 current_id 的第一项；每阶段闭环后由监督调 verify_work_item 留证并推进，所有阶段通过前不可完成。\n" : ""}建立 Minimum Viable Model：调 set_focus_contract，只选本轮唯一交付点；从第一性原理找 1-5 个真正决定结果的变量，写出最简单的计算/判定规则、输出和基线。再定义闭环证据、明确暂不做的范围，以及什么新数据证明模型不够用时才允许增加一个变量或扩一个相邻点。然后用 inject_directive 发给执行端。第一版追求可算、可解释、能解决核心判断，不追求完美。\n\n` +
						humanVoicePolicy("supervisor") + "\n\n" +
						responseLanguageInstruction(latestRequest || this.state.goal),
				);
		} catch (error) {
			if (generation === this.runGeneration && !/abort|cancel/i.test(String(error)))
				this.ui({ kind: "log", level: "warn", text: `监督目标审查失败，已保留待后续验收：${String(error).slice(0, 160)}` });
		} finally {
			if (this.promptGeneration === generation) this.promptGeneration = -1;
		}
		if (generation === this.runGeneration) {
			// 审目标就发现方向不对 → 开工前立刻回灌修正，别等第一轮 token 烧完
			if (this.directives.length > 0 && !this.state.completed) {
				const d = `【监督开工提醒】${this.directives.join("\n")}`;
				this.directives = [];
				this.ui({ kind: "drive", text: d, round: 0 });
			}
		}
	}

	/** 执行端结束一轮 → 核查一次；不达标就继续回灌，直到达成、用户停止或命中显式预算。 */
	async review(assistantText: string): Promise<void> {
		if (this.skipNextReview) {
			this.skipNextReview = false;
			return;
		}
		this.pendingReview = { text: assistantText, generation: this.runGeneration };
		await this.drainPendingWork();
	}

	private async performReview(assistantText: string, generation: number): Promise<void> {
		if (!this.active || this.reviewing || !this.agent || !this.state.goal || generation !== this.runGeneration) return;
		this.reviewing = true;
		this.promptGeneration = generation;
		this.directives = [];
		try {
			this.ui({ kind: "supervisor", sub: "turn", text: "看看这轮做得咋样" });
			const block = domainBlock(classifyTask(`${this.state.goal}\n${this.state.latestRequest}`, this.state.workdir));
			await this.agent.prompt(
				`[稳定主目标] ${this.state.goal}\n[最近用户补充] ${this.state.latestRequest || "（无）"}\n` +
				this.taskContractBrief() + "\n\n" +
				this.workPlanBrief() + "\n\n" +
				this.goalLedgerBrief() + "\n\n" +
				this.capabilityBrief + "\n\n" +
				`【当前任务可用经验包——只作先验，必须按边界重新取证】\n${experiencePackText(retrieveExperiencePack(this.state.workdir, `${this.state.goal}\n${this.state.latestRequest}`))}\n\n` +
				`[你推断的用户真实意图] ${this.state.trueIntent || "（还没推断——先想清楚他真正要什么，调 set_true_intent 写下来）"}\n` +
					`[认知审计] ${this.state.reasoningAudit.goal === this.state.goal && this.state.reasoningAudit.taskId === this.state.taskId && this.state.reasoningAudit.contractVersion === this.state.contractVersion ? JSON.stringify(this.state.reasoningAudit) : "（旧版或尚未覆盖当前合同——完成前必须重新调 set_reasoning_audit）"}\n` +
					`[当前单点契约] ${this.state.focusContract.goal === this.state.goal && this.state.focusContract.taskId === this.state.taskId && this.state.focusContract.contractVersion === this.state.contractVersion ? JSON.stringify(this.state.focusContract) : "（旧版或尚未覆盖当前合同——先调 set_focus_contract，只选一个点）"}\n` +
					`[进度] ${this.state.progress}%\n` +
					`[执行端这一轮屏幕上说的话]\n${assistantText.slice(0, 16000) || "(本轮无可见文本，可能还在干活)"}\n\n` +
					outcomeFirstPolicy("supervisor") + "\n\n" +
					searchFallbackPolicy("supervisor") + "\n\n" +
					`【核查协议——你是审稿人不是听汇报的，必须亲自去看、亲自挑毛病。验收的尺子是真实意图，不是字面目标】\n\n` +
					`第零步：真实意图还对吗\n` +
					`- 用户后续说的话有没有透露新信息，需要修正你推断的真实意图？有就更新 set_true_intent。\n` +
					`- 如果你审目标时已判断方向该修正，这轮坚持你的判断，别被执行端带回字面目标。\n\n` +
					`第一步：亲自去看产出（上面是它"说"了什么，不是它"做"了什么——说的不算数）\n` +
					`- 先调 inspect_task_ledger：检查事实是否带证据、假设是否被错误当作结论、关键缺口是否关闭、失败后是否真正换了路径。缺任何一项就补记录或 inject_directive，不可放行。\n` +
					`- 用 git_diff 看它实际改了哪些文件\n` +
					`- 用 bash/read 打开那些文件，逐段读它真正写出来的内容——代码、文章、分析报告、whatever\n` +
					`- 如果是生成内容（文章/分析/报告），把全文读进来，一段一段看\n\n` +
					`第一点五步：查范围有没有膨胀\n` +
					`- 所有改动都必须服务于【当前单点契约】，不服务的内容即使做得好也属于过度建设，要求撤回或放入 deferred。\n` +
					`- 当前点没达到 doneWhen 前，不讨论第二个点；达到后调 verify_focus_contract 留证据，只能 stop 或 expand 一个相邻点。\n` +
					`- decision=expand 时，马上为唯一的下一个点重设 set_focus_contract，再 inject_directive；不能一次扩多个。\n\n` +
					`- 检查最小模型：变量是否超过 5 个？每个变量是否真的改变输出？计算规则能否由人复算？基线是否明确？如果删掉一个变量仍不影响当前核心判断，就删掉。\n` +
					`- 复杂度只能由数据触发：必须指出现有模型解释不了的真实样本/误差，才能新增一个变量或规则；“以后可能需要”不是升级理由。\n\n` +
					`第二步：挑毛病（带着"这里面一定有问题"的心态去找）\n` +
					`- 逻辑漏洞：论证链条断了没？前后矛盾没？因果关系站得住吗？结论是不是证据撑不起来的？\n` +
					`- 事实硬伤：数据对不对？用 web_search/web_fetch 抽查关键事实，去一手来源验证\n` +
					`- 遗漏：目标要求的维度都覆盖了没？有没有偷懒跳过的部分？有没有该深入但被一笔带过的？\n` +
					`- 可用性：用户能直接拿这个产出用吗？还是需要他自己再改一遍？如果他还得改，那就是没做完\n` +
					(block ? `\n下面是本任务类型的专项检查，逐条过：\n${block}\n` : "\n") +
					`第三步：重新跑一遍认知红队\n` +
					`产出会暴露开工时没看见的新信息。重新检查用户利益函数、隐藏假设、遗漏的利益相关者/约束、反证、替代路径和失败预演；有变化就更新 set_reasoning_audit。\n` +
					`特别问：即使执行端把用户要求做得完美，这件事仍可能为什么失败？如果答案存在，就不能因“按要求做完”而放行。\n\n` +
					`监督不是中立主持人：最后必须替用户拍板净收益最高的方向。没有明确推荐，或推荐没有解释牺牲了什么、保护了什么，就不能放行。\n\n` +
					`第四步：判定\n` +
					`- 找到任何问题 → inject_directive 给完整重做指令，说清哪里有问题、怎么改\n` +
					`- 多流程目标：逐项调 verify_goal_item；目标账本任何一项未验证，mark_complete 会拒绝\n` +
					`- 大任务：当前阶段满足 done_when 后调 verify_work_item 留证，只推进一个依赖已满足的 next_id；所有阶段均验证前不得完成\n` +
					`- 全部过关 → mark_complete（verification_method 写你调了什么工具，evidence 写你挑了什么毛病、为什么最终判过）\n` +
					`- 没亲自读过产出文件就判 → 工具会拒绝你\n\n` +
					`你的职责不是确认"它做了"，而是确认"用户的真实问题解决了"。字面完成≠真正完成。\n\n` +
					humanVoicePolicy("supervisor") + "\n\n" +
					responseLanguageInstruction(this.state.latestRequest || this.state.goal),
			);
			if (generation !== this.runGeneration) return;
			this.emitState();

			if (this.state.completed) {
				this.active = false;
				saveState(this.state);
				this.ui({ kind: "objective", status: "reached", state: { ...this.state } });
				return;
			}
			// 默认持续闭环，不再因固定“4 轮”打断目标。需要预算断路器时由用户显式配置正数。
			if (this.directives.length > 0) {
				if (this.maxRedos > 0 && this.redoCount >= this.maxRedos) {
					this.active = false;
					const reason = `已达到你配置的自动重做预算（${this.maxRedos} 轮），任务进度已保留`;
					this.ui({ kind: "log", level: "warn", text: reason });
					this.ui({ kind: "objective", status: "halted", reason, state: { ...this.state } });
					return;
				}
				this.redoCount++;
				const directive =
					`【监督要求重做｜第 ${this.redoCount} 轮】目标：${this.state.goal}\n` +
					this.directives.join("\n") +
					`\n请据此重做，不要重复上一版的问题。`;
				this.ui({ kind: "drive", text: directive, round: this.redoCount });
			}
		} catch (error) {
			if (generation === this.runGeneration && !/abort|cancel/i.test(String(error)))
				this.ui({ kind: "log", level: "warn", text: `监督验收失败，本轮结果未用于新任务：${String(error).slice(0, 160)}` });
		} finally {
			if (this.promptGeneration === generation) this.promptGeneration = -1;
			this.reviewing = false;
		}
	}

	stop(): void {
		this.active = false;
		this.started = false;
		this.agentInitializationSerial++;
		this.runGeneration++;
		this.promptGeneration = -1;
		this.pendingCritique = undefined;
		this.pendingReview = undefined;
		if (this.compactionTimer) clearTimeout(this.compactionTimer);
		saveState(this.state);
		this.agent?.dispose();
		this.ui({ kind: "done", reason: "stopped", state: { ...this.state } });
	}
}
