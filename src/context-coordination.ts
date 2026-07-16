import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CompactionParticipant = "executor" | "supervisor";

export interface SharedCompactionCheckpoint {
	version: string;
	createdAt: string;
	initiator: CompactionParticipant;
	taskId: string;
	contractVersion: number;
	goal: string;
	latestRequest: string;
	trueIntent: string;
	reasoningAudit: unknown;
	focusContract: unknown;
	progress: number;
	findings: unknown[];
	executorFocus: unknown;
}

const readJson = (file: string): Record<string, any> => {
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
};

const contextDir = (workdir: string, scopeId?: string) => scopeId
	? join(workdir, ".goal-mode-pi", "runs", scopeId, "context")
	: join(workdir, ".goal-mode-pi", "context");
const statePath = (workdir: string, scopeId?: string) => scopeId
	? join(workdir, ".goal-mode-pi", "runs", scopeId, "state.json")
	: join(workdir, ".goal-mode-pi", "state.json");
const thinkingPath = (workdir: string, scopeId?: string) => scopeId
	? join(workdir, ".goal-mode-pi", "runs", scopeId, "thinking", "latest.json")
	: join(workdir, ".goal-mode-pi", "thinking", "latest.json");

export function createSharedCompactionCheckpoint(workdir: string, initiator: CompactionParticipant, scopeId?: string): SharedCompactionCheckpoint {
	const dir = contextDir(workdir, scopeId);
	mkdirSync(dir, { recursive: true });
	const state = readJson(statePath(workdir, scopeId));
	const thinking = readJson(thinkingPath(workdir, scopeId));
	const createdAt = new Date().toISOString();
	const checkpoint: SharedCompactionCheckpoint = {
		version: `${Date.now()}-${initiator}`,
		createdAt,
		initiator,
		taskId: String(state.taskId ?? ""),
		contractVersion: Number(state.contractVersion ?? 0),
		goal: String(state.goal ?? ""),
		latestRequest: String(state.latestRequest ?? ""),
		trueIntent: String(state.trueIntent ?? ""),
		reasoningAudit: state.reasoningAudit ?? {},
		focusContract: state.focusContract ?? thinking.focus ?? {},
		progress: Number(state.progress ?? 0),
		findings: Array.isArray(state.findings) ? state.findings : [],
		executorFocus: thinking.focus ?? {},
	};
	writeFileSync(join(dir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2));
	return checkpoint;
}

export function pendingSharedCompaction(workdir: string, participant: CompactionParticipant, scopeId?: string): SharedCompactionCheckpoint | undefined {
	const dir = contextDir(workdir, scopeId);
	const coordination = readJson(join(dir, "coordination.json"));
	if (coordination.participants?.[participant]?.status !== "requested") return undefined;
	const checkpoint = readJson(join(dir, "checkpoint.json")) as Partial<SharedCompactionCheckpoint>;
	if (!checkpoint.version || checkpoint.version !== coordination.checkpointVersion) return undefined;
	const state = readJson(statePath(workdir, scopeId));
	// 新任务不能消费上一任务遗留的压缩请求，否则旧摘要会重新注入新目标。
	if (String(checkpoint.taskId ?? "") !== String(state.taskId ?? "")) return undefined;
	if (Number(checkpoint.contractVersion ?? 0) !== Number(state.contractVersion ?? 0)) return undefined;
	return checkpoint as SharedCompactionCheckpoint;
}

export function markCompactionParticipant(
	workdir: string,
	participant: CompactionParticipant,
	status: "requested" | "waiting" | "compacting" | "compacted" | "skipped" | "error",
	checkpoint: SharedCompactionCheckpoint,
	message = "",
	scopeId?: string,
): void {
	const dir = contextDir(workdir, scopeId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "coordination.json");
	const current = readJson(file);
	const sameVersion = current.checkpointVersion === checkpoint.version;
	writeFileSync(file, JSON.stringify({
		checkpointVersion: checkpoint.version,
		initiator: checkpoint.initiator,
		updatedAt: new Date().toISOString(),
		participants: {
			...(sameVersion ? current.participants : {}),
			[participant]: { status, message, updatedAt: new Date().toISOString() },
		},
	}, null, 2));
}
