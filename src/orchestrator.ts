import { EventEmitter } from "node:events";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createRpcProcess, type RpcProcess } from "./rpc-process.ts";
import { executorBrief, humanVoicePolicy, responseLanguageInstruction } from "./policy.ts";
import { type GoalModeState, loadState, saveState } from "./state.ts";
import { createSupervisorExtension } from "./supervisor-extension.ts";
import { captureTaskContract, isContinuationOnly, isSupervisorDirective, taskContractBrief } from "./task-contract.ts";

export const SUPERVISOR_POLICY = `你是 goal-mode 的监督 agent，一个极其挑剔的技术总监。
你不写业务代码；你监督另一个执行 agent (executor) 完成用户目标。
铁律：
- 先核查再下结论。怀疑 executor 的自述时，用 git_diff / run_tests / get_executor_transcript 拿事实。
- 只有 run_tests 真正 PASS 才允许 mark_complete。任何"局部成功/大概可行"一律驳回。
- 发现 executor 试图跳过测试或蒙混，log_finding 并 inject_directive 纠正（紧急时 urgent=true 打断）。
- 每一轮：判断进展 → 必要时 set_progress → 给 executor 下一步明确指令，或 mark_complete。
- 目标会随用户对话进化：始终以最新的 [当前目标] 为准，不要拿旧目标卡新任务。
不要长篇大论，调用工具行动。\n\n${humanVoicePolicy("supervisor")}`;

/** 归一化后喂给 UI 的事件 */
export type UIEvent =
	| { kind: "executor"; sub: "text" | "tool" | "turn"; text?: string }
	| { kind: "supervisor"; sub: "text" | "tool" | "tool-result" | "turn"; text?: string }
	| { kind: "state"; state: GoalModeState }
	| { kind: "log"; level: "info" | "warn"; text: string }
	| { kind: "objective"; status: "reached" | "halted"; reason?: string; state: GoalModeState }
	| { kind: "done"; reason: "executor-exit" | "stopped"; state: GoalModeState };

export interface OrchestratorOptions {
	goal: string;
	workdir: string;
	testCmd: string;
	provider?: string;
	maxCycles?: number;
}

/** 把整套双 agent 监督封成一个可启停、发 UIEvent 的对象，供 CLI / Electron / web 复用。 */
export class Orchestrator extends EventEmitter {
	private executor?: RpcProcess;
	private supervisor?: AgentSession;
	private state: GoalModeState;
	private readonly provider: string;
	private readonly maxCycles: number;
	private cycles = 0;
	private assistantText = "";
	private toolCalls: string[] = [];
	private stopped = false;
	private active = false; // 当前目标是否在自动监督中（达成/halt 后置 false，新任务再置 true）
	private readonly goalHistory: string[] = [];

	constructor(opts: OrchestratorOptions) {
		super();
		this.provider = opts.provider ?? "anthropic";
		this.maxCycles = Math.max(0, Math.floor(opts.maxCycles ?? 0));
		const contract = captureTaskContract(opts.workdir, opts.goal, undefined, { source: "user", forceNewTask: true });
		this.state = loadState({
			goal: contract.primaryGoal,
			latestRequest: contract.latestRequest,
			taskId: contract.taskId,
			contractVersion: contract.version,
			workdir: opts.workdir,
			testCmd: opts.testCmd,
		});
		this.goalHistory.push(this.state.goal);
	}

	private ui(e: UIEvent) {
		this.emit("ui", e);
	}
	private emitState() {
		this.ui({ kind: "state", state: { ...this.state } });
	}

	async start(): Promise<void> {
		this.active = true;
		saveState(this.state);
		this.emitState();
		this.ui({ kind: "log", level: "info", text: `executor 开始: ${this.state.goal}` });

		// 1) 执行端
		this.executor = createRpcProcess({
			cwd: this.state.workdir,
			// RPC 已能处理结构化事件；保留正常 extension/Skill/computer-use 能力，
			// 不能为了规避旧版 UI 请求而把执行端整体阉割。
			args: ["--provider", this.provider, "--append-system-prompt", executorBrief()],
		});
		this.executor.onEvent((event) => this.onExecutorEvent(event));
		this.executor.onExit((err) => {
			if (this.stopped) return;
			this.ui({ kind: "log", level: "warn", text: `executor 退出: ${err?.message ?? "clean"}` });
			void this.finish("executor-exit");
		});

		// 2) 监督端
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.state.workdir,
			agentDir: getAgentDir(),
			systemPromptOverride: () => SUPERVISOR_POLICY,
			appendSystemPromptOverride: () => [],
			extensionFactories: [
				// CLI 路径：建议回调直接驱动 executor（GUI 路径才是只读旁挂）
				createSupervisorExtension(this.state, (msg, urgent) => {
					void this.executor?.send(urgent ? { type: "steer", message: msg } : { type: "prompt", message: msg });
				}),
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.state.workdir,
			resourceLoader,
			excludeTools: ["edit", "write"],
			sessionManager: SessionManager.inMemory(this.state.workdir),
		});
		this.supervisor = session;
		this.supervisor.subscribe((event) => this.onSupervisorEvent(event));

		// 3) 启动
		await this.executor.send({ type: "prompt", message: this.state.goal });
	}

	private onExecutorEvent(event: unknown) {
		const e = event as { type: string; toolName?: string; assistantMessageEvent?: { type: string; delta?: string } };
		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			const d = e.assistantMessageEvent.delta ?? "";
			this.assistantText += d;
			this.ui({ kind: "executor", sub: "text", text: d });
		} else if (e.type.includes("tool_call") && e.toolName) {
			this.toolCalls.push(e.toolName);
			this.ui({ kind: "executor", sub: "tool", text: e.toolName });
		} else if (e.type === "agent_end") {
			this.ui({ kind: "executor", sub: "turn", text: "一轮结束" });
			void this.flushToSupervisor();
		}
	}

	private onSupervisorEvent(event: unknown) {
		const e = event as {
			type: string;
			toolName?: string;
			assistantMessageEvent?: { type: string; delta?: string };
		};
		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			this.ui({ kind: "supervisor", sub: "text", text: e.assistantMessageEvent.delta ?? "" });
		} else if (e.type.includes("tool_call") && e.toolName) {
			this.ui({ kind: "supervisor", sub: "tool", text: e.toolName });
		} else if (e.type.includes("tool_result")) {
			this.ui({ kind: "supervisor", sub: "tool-result", text: e.toolName ?? "" });
			this.emitState(); // 监督工具可能改了 state（progress/lastTestPassed/findings）
		}
	}

	private async flushToSupervisor() {
		// active=false 表示当前目标已达成或已 halt，等用户下达新目标再恢复（不拆 agent）
		if (!this.active || this.stopped) return;
		this.cycles++;
		if (this.maxCycles > 0 && this.cycles > this.maxCycles) {
			this.active = false;
			const reason = `已达到你配置的 MAX_CYCLES=${this.maxCycles}，任务进度已保留`;
			this.ui({ kind: "log", level: "warn", text: reason });
			this.ui({ kind: "objective", status: "halted", reason, state: { ...this.state } });
			return;
		}
		const observation =
			`助手输出: ${this.assistantText.trim().slice(0, 1500) || "(无文本)"}\n` +
			`工具调用: ${this.toolCalls.length ? this.toolCalls.join(", ") : "(无)"}`;
		this.assistantText = "";
		this.toolCalls = [];
		this.ui({ kind: "supervisor", sub: "turn", text: `第 ${this.cycles} 轮审查` });
		await this.supervisor?.prompt(
			`[当前稳定主目标] ${this.state.goal}\n[用户最近补充] ${this.state.latestRequest}\n[进度] ${this.state.progress}%\n` +
				`[executor 刚结束的一轮]\n${observation}\n\n` +
				`${taskContractBrief(captureTaskContract(this.state.workdir, "", undefined, { source: "supervisor" }))}\n\n` +
				`核查并决定下一步：用 git_diff/run_tests 拿事实，inject_directive 推进，达成且测试通过才 mark_complete。\n\n` +
				responseLanguageInstruction(this.state.goal),
		);
		this.emitState();
		if (this.state.completed) {
			this.active = false;
			saveState(this.state);
			this.ui({ kind: "objective", status: "reached", state: { ...this.state } }); // 不拆 agent，保持结对待命
		}
	}

	/** 仅终止（用户停止 / executor 崩溃）才拆 agent。达成目标不走这里。 */
	private async finish(reason: "executor-exit" | "stopped") {
		if (this.stopped) return;
		this.stopped = true;
		this.active = false;
		saveState(this.state);
		await this.executor?.dispose();
		this.supervisor?.dispose();
		this.ui({ kind: "done", reason, state: { ...this.state } });
	}

	/** 后续消息：进化监督目标 + 转发给执行 agent，恢复监督。 */
	async sendToExecutor(text: string): Promise<void> {
		if (!text || this.stopped || isSupervisorDirective(text)) return;
		const oldTaskId = this.state.taskId;
		const oldVersion = this.state.contractVersion;
		const contract = captureTaskContract(this.state.workdir, text, undefined, {
			source: "user",
			forceNewTask: this.state.completed && !isContinuationOnly(text),
			forceRevision: this.state.completed && isContinuationOnly(text),
		});
		const taskChanged = oldTaskId !== contract.taskId;
		const contractChanged = taskChanged || oldVersion !== contract.version;
		// 普通输入是同一任务的新要求；只有明确说“新任务”才更换稳定主目标和 taskId。
		this.goalHistory.push(text);
		this.state.taskId = contract.taskId;
		this.state.contractVersion = contract.version;
		this.state.goal = contract.primaryGoal;
		this.state.latestRequest = text.trim();
		if (taskChanged) this.state.reasoningAudit = {
			taskId: contract.taskId,
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
		if (taskChanged) this.state.focusContract = {
			taskId: contract.taskId, contractVersion: 0,
			goal: "", point: "", firstPrinciple: "", variables: [], calculation: "", output: "", baseline: "",
			doneWhen: "", deferred: [], nextTrigger: "",
			status: "unset", evidence: "", decision: "unset",
		};
		this.state.completed = false;
		if (contractChanged) {
			this.state.workRevision++;
			this.state.lastTestPassed = false;
			this.state.lastTestRevision = -1;
		}
		this.cycles = 0;
		this.active = true;
		saveState(this.state);
		this.emitState();
		this.ui({ kind: "executor", sub: "turn", text: taskChanged ? "新任务" : "任务补充" });
		this.ui({ kind: "supervisor", sub: "turn", text: `任务契约更新（共 ${this.goalHistory.length} 次输入）` });
		await this.executor?.send({ type: "prompt", message: text });
	}

	async stop(): Promise<void> {
		await this.finish("stopped");
	}
}
