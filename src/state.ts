import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 共享世界模型。监督 agent 的工具读写它，main 的桥接循环也读它。
 *
 * 落盘到 <workdir>/.goal-mode-pi/state.json —— **刻意 workdir 本地**，
 * 不碰 ~/.pi/goal-mode（那是用户已有 goal-mode 系统的文件，不能共用）。
 */
export interface GoalModeState {
	/** 同一执行 session 内也允许显式切换任务；所有完成证据都绑定到这个 taskId。 */
	taskId: string;
	/** 当前任务合同版本。用户补充实质要求后递增，旧账本/计划/验收自动失效。 */
	contractVersion: number;
	goal: string;
	/** 用户最近一次真实输入；“继续”只更新这里，不覆盖稳定主目标。 */
	latestRequest: string;
	/** 执行端上一轮是否已交付/停止；用于识别下一条独立动作句是新任务，而非旧目标补充。 */
	executorTurnSettled: boolean;
	/** 监督推断的用户真实意图——验收对照它，不对照字面 goal。审目标时必须先写下它。 */
	trueIntent: string;
	/**
	 * 当前目标的认知审计。不能只确认用户说了什么，还要主动寻找用户和执行端都可能没看见的漏洞。
	 * goal 绑定让旧任务留下的审计不能被新任务复用。
	 */
	reasoningAudit: {
			taskId?: string;
			contractVersion?: number;
			goal: string;
			userValueFunction: string;
			hiddenAssumptions: string;
		blindSpots: string;
		disconfirmingEvidence: string;
		alternativePaths: string;
			failurePremortem: string;
			recommendation: string;
		verdict: "proceed" | "reframe" | "stop";
	};
	/** 当前只允许推进的一个点；闭环前禁止横向铺开，闭环后最多扩一个相邻点。 */
	focusContract: {
		taskId?: string;
		contractVersion?: number;
		goal: string;
		point: string;
		firstPrinciple: string;
		variables: string[];
		calculation: string;
		output: string;
		baseline: string;
		doneWhen: string;
		deferred: string[];
		nextTrigger: string;
		status: "unset" | "active" | "verified";
		evidence: string;
		decision: "unset" | "stop" | "expand";
	};
	workdir: string;
	/** 并发会话隔离键；存在时状态写入 runs/<scopeId>，避免同项目任务互相覆盖。 */
	scopeId?: string;
	testCmd: string;
	plan: string;
	progress: number;
	/** mark_complete 的事实门：只有 run_tests 真跑通才为 true */
	lastTestPassed: boolean;
	/** 每次用户实质补充或监督要求修改都会递增；测试 PASS 必须覆盖同一 revision。 */
	workRevision: number;
	lastTestRevision: number;
	findings: string[];
	completed: boolean;
}

function stateFile(workdir: string, scopeId?: string): string {
	return scopeId
		? path.join(workdir, ".goal-mode-pi", "runs", scopeId, "state.json")
		: path.join(workdir, ".goal-mode-pi", "state.json");
}

export function loadState(seed: Partial<GoalModeState> & { workdir: string }): GoalModeState {
	const base: GoalModeState = {
		taskId: "",
		contractVersion: 0,
		goal: "",
		latestRequest: "",
		executorTurnSettled: false,
		trueIntent: "",
		reasoningAudit: {
			goal: "",
			userValueFunction: "",
			hiddenAssumptions: "",
			blindSpots: "",
			disconfirmingEvidence: "",
			alternativePaths: "",
			failurePremortem: "",
			recommendation: "",
			verdict: "reframe",
		},
		focusContract: {
			goal: "",
			point: "",
			firstPrinciple: "",
			variables: [],
			calculation: "",
			output: "",
			baseline: "",
			doneWhen: "",
			deferred: [],
			nextTrigger: "",
			status: "unset",
			evidence: "",
			decision: "unset",
		},
		workdir: seed.workdir,
		testCmd: "",
		plan: "",
		progress: 0,
		lastTestPassed: false,
		workRevision: 0,
		lastTestRevision: -1,
		findings: [],
		completed: false,
	};
	let disk: Partial<GoalModeState> = {};
	try {
		disk = JSON.parse(fs.readFileSync(stateFile(seed.workdir, seed.scopeId), "utf8"));
	} catch {
		// 首次运行，无盘上状态
	}
	const merged = { ...base, ...disk, ...seed } as GoalModeState;
	merged.reasoningAudit = { ...base.reasoningAudit, ...(disk.reasoningAudit ?? {}), ...(seed.reasoningAudit ?? {}) };
	merged.focusContract = { ...base.focusContract, ...(disk.focusContract ?? {}), ...(seed.focusContract ?? {}) };
	return merged;
}

export function saveState(state: GoalModeState): void {
	const f = stateFile(state.workdir, state.scopeId);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, JSON.stringify(state, null, 2));
}
