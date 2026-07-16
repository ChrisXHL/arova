import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UIEvent } from "./ui-events.ts";

type StoredSupervisorEvent = { at: string; event: UIEvent };
export type SupervisorHistoryPage = { events: UIEvent[]; total: number; truncated: boolean; legacy?: boolean };

function validScopeId(scopeId: string): boolean {
	return /^[\w.-]+$/.test(scopeId);
}

function supervisorDir(workdir: string, scopeId: string): string {
	if (!validScopeId(scopeId)) throw new Error("invalid supervisor scope");
	return join(workdir, ".goal-mode-pi", "runs", scopeId, "supervisor");
}

// v2 起任务记忆已按 session 隔离；旧 agent-session 可能混入项目级任务结论，不能继续复用。
const SUPERVISOR_CONTEXT_DIR = "agent-session-v2";

/**
 * 监督 agent 的真实对话上下文与执行 session 一一绑定。
 * 没有 scopeId 的一次性/测试监督仍保持内存模式，避免不同 loop 串成一场对话。
 */
export function supervisorSessionManager(workdir: string, scopeId?: string, taskId?: string): SessionManager {
	if (!scopeId) return SessionManager.inMemory(workdir);
	try {
		if (taskId && !validScopeId(taskId)) throw new Error("invalid supervisor task scope");
		const dir = taskId
			? join(supervisorDir(workdir, scopeId), "tasks", taskId, SUPERVISOR_CONTEXT_DIR)
			: join(supervisorDir(workdir, scopeId), SUPERVISOR_CONTEXT_DIR);
		mkdirSync(dir, { recursive: true });
		return SessionManager.continueRecent(workdir, dir);
	} catch {
		// 历史盘损坏/只读时宁可本轮退回内存，也不能让监督初始化掀翻执行端连接。
		return SessionManager.inMemory(workdir);
	}
}

function shouldRecord(event: UIEvent): boolean {
	if (event.kind === "supervisor" || event.kind === "drive" || event.kind === "objective" || event.kind === "done") return true;
	return event.kind === "log" && event.level === "warn";
}

function legacyStateSummary(workdir: string, scopeId: string): SupervisorHistoryPage | null {
	try {
		const state = JSON.parse(readFileSync(join(workdir, ".goal-mode-pi", "runs", scopeId, "state.json"), "utf8")) as {
			goal?: string;
			trueIntent?: string;
			reasoningAudit?: { recommendation?: string; blindSpots?: string; verdict?: string };
			focusContract?: { point?: string; status?: string; evidence?: string };
			findings?: string[];
		};
		if (!state.goal && !state.trueIntent) return null;
		const lines = [
			"这场会话创建于监督逐轮历史功能上线前，下面内容由当时留下的最终监督状态恢复，不是完整时间线。",
			state.goal ? `目标：${state.goal}` : "",
			state.trueIntent ? `真实意图：${state.trueIntent}` : "",
			state.reasoningAudit?.blindSpots ? `发现的盲区：${state.reasoningAudit.blindSpots}` : "",
			state.reasoningAudit?.recommendation ? `监督建议：${state.reasoningAudit.recommendation}` : "",
			state.reasoningAudit?.verdict ? `方向判断：${state.reasoningAudit.verdict}` : "",
			state.focusContract?.point ? `当前单点：${state.focusContract.point}` : "",
			state.focusContract?.evidence ? `闭环证据：${state.focusContract.evidence}` : "",
			...(state.findings ?? []).slice(-8).map((x) => `核查发现：${x}`),
		].filter(Boolean);
		return {
			events: [
				{ kind: "supervisor", sub: "turn", text: "旧会话监督摘要" },
				{ kind: "supervisor", sub: "text", text: lines.join("\n") },
			],
			total: 2,
			truncated: false,
			legacy: true,
		};
	} catch {
		return null;
	}
}

/** 追加监督面板历史；连续 token delta 先合并，避免一场对话产生数万条碎记录。 */
export class SupervisorHistoryWriter {
	private readonly file?: string;
	private pendingText = "";
	private flushTimer?: ReturnType<typeof setTimeout>;

	constructor(workdir: string, scopeId: string) {
		try {
			const dir = supervisorDir(workdir, scopeId);
			mkdirSync(dir, { recursive: true });
			this.file = join(dir, "ui-events.jsonl");
		} catch {
			// 记录历史是增强能力，不能因为磁盘异常破坏实时会话。
		}
	}

	append(event: UIEvent): void {
		if (!shouldRecord(event)) return;
		if (event.kind === "supervisor" && event.sub === "text") {
			this.pendingText += event.text ?? "";
			if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 180);
			return;
		}
		this.flush();
		this.write(event);
	}

	flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (!this.pendingText) return;
		const text = this.pendingText;
		this.pendingText = "";
		this.write({ kind: "supervisor", sub: "text", text });
	}

	close(): void {
		this.flush();
	}

	private write(event: UIEvent): void {
		if (!this.file) return;
		const row: StoredSupervisorEvent = { at: new Date().toISOString(), event };
		try {
			appendFileSync(this.file, `${JSON.stringify(row)}\n`);
		} catch {
			/* 实时执行优先；写盘失败不向上传播。 */
		}
	}
}

/** 文件保留完整历史，面板首屏只回放最近一段，避免超长会话重新进入时卡顿。 */
export function readSupervisorHistory(workdir: string, scopeId: string, limit = 600): SupervisorHistoryPage | null {
	if (!validScopeId(scopeId)) return null;
	const file = join(supervisorDir(workdir, scopeId), "ui-events.jsonl");
	if (!existsSync(file)) return legacyStateSummary(workdir, scopeId);
	let text = "";
	let clippedByBytes = false;
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const maxBytes = 4 * 1024 * 1024;
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		text = buffer.toString("utf8");
		if (start > 0) {
			clippedByBytes = true;
			text = text.slice(text.indexOf("\n") + 1); // 丢掉从文件中间截到的残行
		}
	} catch {
		return null;
	} finally {
		if (fd != null) {
			try { closeSync(fd); } catch { /* ignore close failure */ }
		}
	}
	const events: UIEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line) as StoredSupervisorEvent;
			if (row?.event && shouldRecord(row.event)) events.push(row.event);
		} catch {
			/* 末行若因异常退出写了一半，忽略它，前面的历史仍可恢复。 */
		}
	}
	const take = Math.max(1, Math.min(limit, 1000));
	if (!events.length) return legacyStateSummary(workdir, scopeId);
	return { events: events.slice(-take), total: events.length, truncated: clippedByBytes || events.length > take };
}
