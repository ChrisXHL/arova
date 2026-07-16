export const QUEUE_SCHEMA_VERSION = 1;

export type QueueState =
	| "draft"
	| "ready"
	| "running"
	| "pausing"
	| "paused"
	| "needs_attention"
	| "cancelling"
	| "cancelled"
	| "completed"
	| "completed_with_waivers";

export type QueueItemStatus =
	| "pending"
	| "leased"
	| "running"
	| "validating"
	| "reviewing"
	| "retry_wait"
	| "verified"
	| "blocked"
	| "waived"
	| "cancelled";

export type QueueReviewPolicy = "always" | "when_needed" | "never";

export type QueueErrorCategory =
	| "rate_limit"
	| "auth"
	| "transient"
	| "validation"
	| "worker_crash"
	| "cancelled"
	| "unknown";

export interface QueueError {
	category: QueueErrorCategory;
	message: string;
	retryable: boolean;
	requestId?: string;
	occurredAt: string;
}

export interface QueueSkillSnapshot {
	name: string;
	instructions: string;
	sha256: string;
}

export interface QueueCheckSpec {
	id: string;
	type: string;
	config?: Record<string, unknown>;
}

export interface QueueContractSpec {
	primaryGoal: string;
	requirements: string[];
	skills: Array<Omit<QueueSkillSnapshot, "sha256"> & { sha256?: string }>;
	inputSchema: Record<string, unknown>;
	outputSchema: Record<string, unknown>;
	itemPromptTemplate: string;
	deterministicChecks: QueueCheckSpec[];
	semanticReviewPolicy: QueueReviewPolicy;
	maxSemanticRedos: number;
	maxTransientRetries: number;
	/** 0/undefined 表示不按墙钟时间中止；需要预算时由用户显式配置。 */
	itemTimeoutMs?: number;
}

export interface QueueContract extends Omit<QueueContractSpec, "skills"> {
	queueId: string;
	version: number;
	hash: string;
	createdAt: string;
	skills: QueueSkillSnapshot[];
}

export interface QueueAttemptSummary {
	id: string;
	number: number;
	workerId: string;
	sessionId: string;
	contractHash: string;
	promptHash: string;
	status: "running" | "validating" | "reviewing" | "verified" | "failed" | "cancelled";
	startedAt: string;
	endedAt?: string;
	resultRef?: string;
	validationRef?: string;
	reviewRef?: string;
	error?: QueueError;
}

export interface QueueItem {
	id: string;
	sourceKey: string;
	inputRef: string;
	inputDigest: string;
	status: QueueItemStatus;
	attempts: QueueAttemptSummary[];
	leaseOwner?: string;
	leaseUntil?: string;
	nextAttemptAt?: string;
	activeAttemptId?: string;
	/** 人工重新放行后从这里重新计算本轮重试预算，历史 Attempt 仍完整保留。 */
	retryBudgetStartAttempt?: number;
	resultRef?: string;
	lastError?: QueueError;
	waiver?: { reason: string; actor: string; at: string };
	version: number;
}

export interface QueueSnapshot {
	schemaVersion: typeof QUEUE_SCHEMA_VERSION;
	id: string;
	cwd: string;
	title: string;
	state: QueueState;
	contractVersion: number;
	contractHash: string;
	configuredConcurrency: number;
	effectiveConcurrency: number;
	items: QueueItem[];
	seq: number;
	createdAt: string;
	updatedAt: string;
	pausedReason?: string;
	retryAt?: string;
}

export interface QueueStats {
	total: number;
	pending: number;
	running: number;
	retryWait: number;
	verified: number;
	blocked: number;
	waived: number;
	cancelled: number;
	progress: number;
}

export interface QueueItemInput {
	id?: string;
	sourceKey: string;
	payload: unknown;
}

export type QueueMutablePatch = Partial<Pick<
	QueueSnapshot,
	"title" | "state" | "configuredConcurrency" | "effectiveConcurrency" | "pausedReason" | "retryAt"
>>;

export type QueueItemPatch = Partial<Omit<QueueItem, "id" | "sourceKey" | "inputRef" | "inputDigest" | "attempts" | "version">>;

export type QueueAttemptPatch = Partial<Omit<QueueAttemptSummary, "id" | "number" | "workerId" | "sessionId" | "contractHash" | "startedAt">>;

export type QueueEvent =
	| { seq: number; at: string; type: "queue-created"; snapshot: Omit<QueueSnapshot, "seq" | "updatedAt"> }
	| { seq: number; at: string; type: "queue-patched"; patch: QueueMutablePatch }
	| { seq: number; at: string; type: "item-patched"; itemId: string; expectedVersion: number; patch: QueueItemPatch }
	| { seq: number; at: string; type: "attempt-added"; itemId: string; expectedVersion: number; attempt: QueueAttemptSummary }
	| { seq: number; at: string; type: "attempt-patched"; itemId: string; attemptId: string; patch: QueueAttemptPatch };

export interface QueueCreateOptions {
	queueId?: string;
	title?: string;
	configuredConcurrency?: number;
}

export interface QueueRunResult {
	itemId: string;
	attemptId: string;
	contractHash: string;
	inputDigest: string;
	outcome: "changed" | "no_change" | "blocked";
	observations: Array<{ field: string; before: unknown; conclusion: string }>;
	changes: Array<{ field: string; before: unknown; after: unknown; reason: string }>;
	evidence: Array<{ field: string; source: string; retrievedAt: string; evidenceHash: string }>;
	unresolved: Array<{ field: string; reason: string; nextAction: string }>;
	writeback?: {
		idempotencyKey: string;
		requestResult: string;
		beforeDigest: string;
		afterDigest: string;
		readAfterWritePassed: boolean;
	};
	skillUsage: Array<{ name: string; sha256: string }>;
}

export interface QueueReviewDecision {
	verdict: "approved" | "redo" | "blocked";
	reason: string;
	evidence: string;
	redoInstruction?: string;
}

export type QueueWireEvent =
	| { kind: "queue-snapshot"; queueId: string; snapshot: QueueSnapshot; stats: QueueStats }
	| { kind: "queue-item"; queueId: string; itemId: string; status: QueueItemStatus }
	| { kind: "queue-rate-limit"; queueId: string; retryAt: string; effectiveConcurrency: number }
	| { kind: "queue-needs-attention"; queueId: string; itemId: string; reason: string }
	| { kind: "queue-worker"; queueId: string; itemId: string; workerId: string; text: string };
