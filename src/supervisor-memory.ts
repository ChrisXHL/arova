import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 监督的项目记忆：<workdir>/.goal-mode-pi/supervisor-memory.md
 *
 * 监督会话是 inMemory 的，重启即失忆——这个文件是跨会话的持久层。
 * 开工时整体注入系统提示；监督用 remember 工具往里追加。
 * 存的是"会改变下次判断的东西"（用户在乎什么/打回过什么/竞品结论/项目的坑），不是流水账。
 */

/** 默认完整加载；只有用户显式配置预算时才压缩展示，而且会明确标出省略量。 */
function memoryForPrompt(raw: string): string {
	const configured = Number(process.env.GOAL_MODE_MEMORY_MAX_CHARS ?? 0);
	if (!Number.isFinite(configured) || configured <= 0 || raw.length <= configured) return raw;
	const budget = Math.max(1_000, Math.floor(configured));
	const head = Math.floor(budget / 2);
	const tail = budget - head;
	return `${raw.slice(0, head)}\n\n（中间 ${raw.length - budget} 个字符因你显式配置的 GOAL_MODE_MEMORY_MAX_CHARS=${budget} 未注入；原文仍完整保存在记忆文件）\n\n${raw.slice(-tail)}`;
}

/** 跨项目共享的用户记忆，只存稳定偏好、长期目标、决策原则与不可触碰的底线。 */
export function userMemoryFile(): string {
	return join(homedir(), ".goal-mode-pi", "user-memory.md");
}

export function loadUserMemory(): string {
	try {
		const raw = readFileSync(userMemoryFile(), "utf8").trim();
		if (!raw) return "";
		return memoryForPrompt(raw);
	} catch {
		return "";
	}
}

/** 旧版项目级记忆：仅供没有会话隔离键的 CLI/兼容路径读取。 */
export function memoryFile(workdir: string): string {
	return join(workdir, ".goal-mode-pi", "supervisor-memory.md");
}

/** GUI 监督默认按执行 session 隔离，避免 A 任务的结论污染 B 任务。 */
export function sessionMemoryFile(workdir: string, scopeId: string, taskId?: string): string {
	if (!/^[\w.-]+$/.test(scopeId)) throw new Error("invalid supervisor memory scope");
	if (taskId && !/^[\w.-]+$/.test(taskId)) throw new Error("invalid supervisor task scope");
	return taskId
		? join(workdir, ".goal-mode-pi", "runs", scopeId, "tasks", taskId, "supervisor-memory.md")
		: join(workdir, ".goal-mode-pi", "runs", scopeId, "supervisor-memory.md");
}

function readMemory(file: string): string {
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (!raw) return "";
		return memoryForPrompt(raw);
	} catch {
		return "";
	}
}

export function loadSupervisorMemory(workdir: string, scopeId?: string, taskId?: string): string {
	// 有 scope 的 live 会话绝不回退读旧项目级记忆；旧文件里可能混入另一个任务的结论。
	return readMemory(scopeId ? sessionMemoryFile(workdir, scopeId, taskId) : memoryFile(workdir));
}

export function appendSupervisorMemory(workdir: string, lesson: string, scopeId?: string, taskId?: string): void {
	const f = scopeId ? sessionMemoryFile(workdir, scopeId, taskId) : memoryFile(workdir);
	mkdirSync(dirname(f), { recursive: true });
	const date = new Date().toISOString().slice(0, 10);
	appendFileSync(f, `- [${date}] ${lesson.replace(/\s*\n+\s*/g, "；").trim()}\n`);
}

export function appendUserMemory(lesson: string): boolean {
	const f = userMemoryFile();
	const normalized = lesson.replace(/\s*\n+\s*/g, "；").trim();
	let old = "";
	try {
		old = readFileSync(f, "utf8");
	} catch {
		/* 首条用户记忆 */
	}
	// 完全相同的稳定偏好不重复追加，避免系统提示被同一句话淹没。
	if (old.split("\n").some((line) => line.replace(/^- \[\d{4}-\d{2}-\d{2}\] /, "").trim() === normalized)) return false;
	mkdirSync(dirname(f), { recursive: true });
	const date = new Date().toISOString().slice(0, 10);
	appendFileSync(f, `- [${date}] ${normalized}\n`);
	return true;
}
