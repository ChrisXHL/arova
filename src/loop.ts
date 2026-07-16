import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverGoals } from "./discover.ts";
import { executorBrief } from "./policy.ts";
import { spawnPiPty } from "./pty-exec.ts";
import { SessionWatch } from "./session-watch.ts";
import { Supervisor } from "./supervisor.ts";
import { RateLimitRecovery, RATE_LIMIT_RESUME_PROMPT } from "./rate-limit-recovery.ts";
import { isSupervisorDirective } from "./task-contract.ts";
import type { UIEvent } from "./ui-events.ts";

/**
 * 自驱动循环（loop engineering）。一次轮转走完五个动作：
 *   发现   ← 分诊 agent 读项目信号挖目标 + 读 backlog（不是人逐条喂）
 *   交接   ← 起一个无人值守的真实 pi 执行它
 *   验证   ← 复用独立怀疑评估器(Supervisor)：核查 + 自动回灌，默认持续到达标/用户暂停/真实阻塞
 *   持久化 ← 结果写 loop-log.md，backlog 勾 [x]/[⚠]（跨轮记忆 + 收件箱）
 *   调度   ← 可选定时自醒
 * 人工门：从不自动 git commit；卡住的进收件箱等你看。
 * 既能当 CLI(headless)，也能被 GUI 驱动（emit "event" 把每一步推给前端）。
 */

export interface LoopOpts {
	workdir: string;
	provider?: string;
	maxGoalsPerRun: number;
	perGoalTimeoutMs: number;
}

export type QueueItem = { goal: string; status: "done" | "blocked" | "pending" };

/** 推给 GUI 的事件：执行端终端字节 + 监督事件 + 循环生命周期 + 队列。 */
export type LoopEvent =
	| { kind: "term"; data: string } // 当前目标执行端 pi 的终端输出
	| { kind: "term-reset" } // 切到下一个目标，清屏
	| { kind: "loop"; sub: "discover-start" }
	| { kind: "loop"; sub: "discovered"; added: number; pending: number }
	| { kind: "loop"; sub: "goal-start"; goal: string; index: number; total: number }
	| { kind: "loop"; sub: "goal-done"; goal: string; status: "done" | "blocked" | "paused" }
	| { kind: "loop"; sub: "round-done"; done: number; blocked: number; paused: number }
	| { kind: "queue"; items: QueueItem[] }
	| UIEvent; // 监督事件透传

function gmDir(workdir: string): string {
	const d = join(workdir, ".goal-mode-pi");
	mkdirSync(d, { recursive: true });
	return d;
}
const backlogPath = (w: string) => join(gmDir(w), "backlog.md");
const logPath = (w: string) => join(gmDir(w), "loop-log.md");

/** 把 backlog 解析成带状态的队列项（供 GUI 显示）。 */
function readQueue(workdir: string): QueueItem[] {
	const f = backlogPath(workdir);
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.map((l) => l.match(/^\s*-\s*\[(.)\]\s+(.+)$/))
		.filter((m): m is RegExpMatchArray => !!m)
		.map((m) => ({
			goal: m[2].trim(),
			status: m[1] === "x" ? "done" : m[1] === "⚠" ? "blocked" : "pending",
		}));
}

/** 发现：读 backlog.md 里 "- [ ] 目标" 的未完成项。 */
function discover(workdir: string): Array<{ lineIdx: number; goal: string }> {
	const f = backlogPath(workdir);
	if (!existsSync(f)) return [];
	const lines = readFileSync(f, "utf8").split("\n");
	const out: Array<{ lineIdx: number; goal: string }> = [];
	lines.forEach((l, i) => {
		const m = l.match(/^\s*-\s*\[\s\]\s+(.+)$/);
		if (m) out.push({ lineIdx: i, goal: m[1].trim() });
	});
	return out;
}

/** 发现的目标去重后追加进 backlog 队列。 */
function appendDiscovered(workdir: string, goals: string[]): number {
	const f = backlogPath(workdir);
	const existing = existsSync(f) ? readFileSync(f, "utf8") : "# goal-mode-pi backlog\n";
	const fresh = goals.filter((g) => g && !existing.includes(g));
	if (fresh.length === 0) return 0;
	writeFileSync(f, `${existing.replace(/\n*$/, "")}\n${fresh.map((g) => `- [ ] ${g}`).join("\n")}\n`);
	return fresh.length;
}

function markBacklog(workdir: string, lineIdx: number, status: "done" | "blocked") {
	const f = backlogPath(workdir);
	const lines = readFileSync(f, "utf8").split("\n");
	const mark = status === "done" ? "x" : "⚠";
	lines[lineIdx] = lines[lineIdx].replace(/^(\s*-\s*)\[\s\]/, `$1[${mark}]`);
	writeFileSync(f, lines.join("\n"));
}

function appendLog(workdir: string, goal: string, status: "done" | "blocked" | "paused", findings: string[]) {
	const label = status === "done" ? "✅ 达成" : status === "blocked" ? "⚠ 卡住（待你看）" : "○ 已暂停（保留待办）";
	const head = `\n## ${new Date().toISOString()} ${label}\n目标：${goal}\n`;
	const body = findings.length ? `${findings.map((x) => `- ${x}`).join("\n")}\n` : "（无 findings）\n";
	appendFileSync(logPath(workdir), head + body);
}

export class Loop extends EventEmitter {
	private stopped = false;
	private currentFinish?: (s: "done" | "blocked" | "paused") => void;
	private readonly opts: LoopOpts;

	constructor(opts: LoopOpts) {
		super();
		this.opts = opts;
	}
	private ev(e: LoopEvent) {
		this.emit("event", e);
	}
	private emitQueue() {
		this.ev({ kind: "queue", items: readQueue(this.opts.workdir) });
	}

	/** 交接+验证：默认不限时；显式超时只暂停并保留待办，不能伪装成真实阻塞。 */
	private runGoal(goal: string): Promise<{ status: "done" | "blocked" | "paused"; findings: string[] }> {
		return new Promise((resolve) => {
			const exec = spawnPiPty({ cwd: this.opts.workdir, provider: this.opts.provider, appendSystemPrompt: executorBrief(), extraArgs: ["-a"] });
			const watch = new SessionWatch(exec.sessionDir);
			const sup = new Supervisor({
				workdir: this.opts.workdir,
				testCmd: process.env.TEST_CMD || "",
				provider: this.opts.provider,
			});
			let findings: string[] = [];
			let baseFindings = -1;
			let lastOut = Date.now();
			let booted = false;
			let done = false;
			const start = Date.now();
			const rateLimitRecovery = new RateLimitRecovery({
				onWait: (delayMs, attempt, requestId) => this.ev({
					kind: "log",
					level: "warn",
					text: `服务限流，${Math.ceil(delayMs / 1000)} 秒后自动恢复当前目标（第 ${attempt} 次长退避${requestId ? `，${requestId}` : ""}）`,
				}),
				onRetry: () => exec.pty.write(`${RATE_LIMIT_RESUME_PROMPT}\r`),
			});
			exec.pty.onData((d) => {
				lastOut = Date.now();
				rateLimitRecovery.observeTerminal(d);
				this.ev({ kind: "term", data: d }); // 终端字节推给 GUI
			});

			const finish = (status: "done" | "blocked" | "paused") => {
				if (done) return;
				done = true;
				this.currentFinish = undefined;
				clearInterval(boot);
				if (timeout) clearTimeout(timeout);
				rateLimitRecovery.cancel();
				watch.stop();
				sup.stop();
				try {
					exec.pty.kill();
				} catch {
					/* gone */
				}
				resolve({ status, findings });
			};
			this.currentFinish = finish;

			sup.on("ui", (e: UIEvent) => {
				this.ev(e); // 监督事件透传给 GUI 右栏
				if (e.kind === "drive") exec.pty.write(`${e.text}\r`);
				else if (e.kind === "state") {
					if (baseFindings < 0) baseFindings = e.state.findings.length;
					findings = e.state.findings.slice(baseFindings);
				} else if (e.kind === "objective") finish(e.status === "reached" ? "done" : "paused");
			});

			// 先监听执行端，再异步初始化监督。启动慢时首条任务会进入 Supervisor 的待处理队列，不能丢。
			watch.on("user-task", (t) => {
				if (!isSupervisorDirective(t)) rateLimitRecovery.reset();
				sup.onUserTask(t);
			});
			watch.on("turn-end", (t) => {
				rateLimitRecovery.reset();
				sup.noteExecutorTurnSettled();
				void sup.review(t);
			});
			watch.on("turn-cancelled", (reason) => sup.cancelCurrent(reason));
			watch.start();
			void sup.start().catch((error) => {
				this.ev({ kind: "log", level: "warn", text: `监督初始化失败，执行任务仍保留：${String(error).slice(0, 160)}` });
			});

			const boot = setInterval(() => {
				if (booted) return;
				if (Date.now() - start > 6000 && Date.now() - lastOut > 2000) {
					booted = true;
					exec.pty.write(goal);
					setTimeout(() => exec.pty.write("\r"), 500);
				}
			}, 500);
			const timeout = this.opts.perGoalTimeoutMs > 0 ? setTimeout(() => finish("paused"), this.opts.perGoalTimeoutMs) : undefined;
		});
	}

	/** 跑一轮：发现 → 逐个执行+验证 → 持久化。 */
	async runOnce(): Promise<void> {
		this.ensureBacklog();
		// 发现
		if (process.env.DISCOVER !== "0" && !this.stopped) {
			this.ev({ kind: "loop", sub: "discover-start" });
			try {
				const found = await discoverGoals(this.opts.workdir, this.opts.provider);
				const added = appendDiscovered(this.opts.workdir, found);
				this.ev({ kind: "loop", sub: "discovered", added, pending: discover(this.opts.workdir).length });
			} catch (e) {
				this.ev({ kind: "log", level: "warn", text: `发现失败（仅用现有 backlog）：${String(e).slice(0, 120)}` });
			}
		}
		this.emitQueue();

		const items = discover(this.opts.workdir).slice(0, this.opts.maxGoalsPerRun);
		let nDone = 0;
		let nBlocked = 0;
		let nPaused = 0;
		for (let i = 0; i < items.length && !this.stopped; i++) {
			const it = items[i];
			this.ev({ kind: "term-reset" });
			this.ev({ kind: "loop", sub: "goal-start", goal: it.goal, index: i + 1, total: items.length });
			const { status, findings } = await this.runGoal(it.goal);
			if (status !== "paused") markBacklog(this.opts.workdir, it.lineIdx, status);
			appendLog(this.opts.workdir, it.goal, status, findings);
			if (status === "done") nDone++;
			else if (status === "blocked") nBlocked++;
			else nPaused++;
			this.ev({ kind: "loop", sub: "goal-done", goal: it.goal, status });
			this.emitQueue();
		}
		this.ev({ kind: "loop", sub: "round-done", done: nDone, blocked: nBlocked, paused: nPaused });
	}

	private ensureBacklog() {
		const f = backlogPath(this.opts.workdir);
		if (!existsSync(f)) {
			writeFileSync(
				f,
				"# goal-mode-pi backlog\n# 每行一个目标(- [ ] xxx)。你可手写，loop 也会自动发现并追加。完成勾 [x]，卡住标 [⚠]。\n",
			);
		}
	}

	stop() {
		this.stopped = true;
		this.currentFinish?.("paused");
	}
}

// ---- CLI (headless)：创建 Loop，把事件打到终端 ----
async function main() {
	const workdir = process.env.WORKDIR || process.cwd();
	const opts: LoopOpts = {
		workdir,
		provider: process.env.PI_PROVIDER,
		maxGoalsPerRun: Number(process.env.MAX_GOALS ?? 3),
		perGoalTimeoutMs: Number(process.env.GOAL_TIMEOUT_MS ?? 0),
	};
	const intervalMs = process.env.INTERVAL_MS ? Number(process.env.INTERVAL_MS) : undefined;

	const loop = new Loop(opts);
	loop.on("event", (e: LoopEvent) => {
		if (e.kind === "loop" && e.sub === "discover-start") console.log("[loop] 发现中：分诊项目信号…");
		else if (e.kind === "loop" && e.sub === "discovered") console.log(`[loop] 新增 ${e.added} 个目标，待办 ${e.pending}`);
		else if (e.kind === "loop" && e.sub === "goal-start") console.log(`\n▶ [${e.index}/${e.total}] ${e.goal}`);
		else if (e.kind === "loop" && e.sub === "goal-done") console.log(`  ${e.status === "done" ? "✅ 达成" : e.status === "blocked" ? "⚠ 卡住→收件箱" : "○ 已暂停，待办已保留"}`);
		else if (e.kind === "loop" && e.sub === "round-done")
			console.log(`\n[loop] 本轮结束：达成 ${e.done}，卡住 ${e.blocked}，暂停 ${e.paused}。看 ${logPath(workdir)} 与 git diff 复核（不会自动提交）。`);
		else if (e.kind === "log") console.log(`[${e.level}] ${e.text}`);
	});

	await loop.runOnce();
	if (intervalMs) {
		console.log(`[loop] ${intervalMs / 1000}s 后再次自醒（Ctrl+C 停）`);
		setInterval(() => void loop.runOnce(), intervalMs);
	}
}

if (process.argv[1]?.endsWith("loop.ts")) void main();
