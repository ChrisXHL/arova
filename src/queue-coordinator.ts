import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ProviderLimiter, sharedProviderLimiter } from "./provider-limiter.ts";
import { QueueReviewer, type QueueReviewerLike } from "./queue-reviewer.ts";
import { QueueStore, queueStats } from "./queue-store.ts";
import type {
	QueueAttemptSummary,
	QueueError,
	QueueItem,
	QueueItemStatus,
	QueueReviewDecision,
	QueueSnapshot,
	QueueWireEvent,
} from "./queue-types.ts";
import { classifyQueueError, validateQueueRunResult } from "./queue-validator.ts";
import { QueueWorker, type QueueWorkerEvent, type QueueWorkerOptions, type QueueWorkerResult } from "./queue-worker.ts";

export interface QueueWorkerLike {
	run(): Promise<QueueWorkerResult>;
	abort(): Promise<void>;
	on?(event: "event", listener: (event: QueueWorkerEvent) => void): unknown;
}

export interface QueueCoordinatorOptions {
	cwd: string;
	queueId: string;
	provider?: string;
	leaseMs?: number;
	heartbeatMs?: number;
	tickMs?: number;
	workerFactory?: (options: QueueWorkerOptions) => QueueWorkerLike;
	reviewer?: QueueReviewerLike;
	limiter?: ProviderLimiter;
}

type ActiveWorker = {
	itemId: string;
	workerId: string;
	attemptId: string;
	worker: QueueWorkerLike;
};

const TERMINAL_QUEUE_STATES = new Set(["cancelled", "completed", "completed_with_waivers"]);

export class QueueCoordinator extends EventEmitter {
	readonly store: QueueStore;
	private readonly provider?: string;
	private readonly leaseMs: number;
	private readonly heartbeatMs: number;
	private readonly tickMs: number;
	private readonly workerFactory: (options: QueueWorkerOptions) => QueueWorkerLike;
	private readonly reviewer: QueueReviewerLike;
	private readonly limiter: ProviderLimiter;
	private readonly active = new Map<string, ActiveWorker>();
	private timer?: ReturnType<typeof setInterval>;
	private ticking = false;
	private disposed = false;

	constructor(options: QueueCoordinatorOptions) {
		super();
		this.store = new QueueStore(options.cwd, options.queueId);
		this.provider = options.provider;
		this.leaseMs = options.leaseMs ?? 120_000;
		this.heartbeatMs = options.heartbeatMs ?? 30_000;
		this.tickMs = options.tickMs ?? 250;
		this.workerFactory = options.workerFactory ?? ((workerOptions) => new QueueWorker(workerOptions));
		this.reviewer = options.reviewer ?? new QueueReviewer(options.cwd);
		const snapshot = this.store.getSnapshot();
		this.limiter = options.limiter ?? sharedProviderLimiter(options.provider || "default", snapshot.configuredConcurrency);
	}

	private ev(event: QueueWireEvent): void {
		this.emit("event", event);
	}

	private publishSnapshot(snapshot = this.store.getSnapshot()): void {
		this.ev({ kind: "queue-snapshot", queueId: snapshot.id, snapshot, stats: queueStats(snapshot) });
	}

	private publishItem(item: QueueItem): void {
		this.ev({ kind: "queue-item", queueId: this.store.queueId, itemId: item.id, status: item.status });
		this.publishSnapshot();
	}

	getSnapshot(): QueueSnapshot {
		return this.store.getSnapshot();
	}

	async recoverAfterRestart(): Promise<number> {
		const recovered = await this.store.recoverAfterRestart();
		const snapshot = this.store.getSnapshot();
		if (snapshot.state === "running" || snapshot.state === "pausing") {
			await this.store.patchQueue({ state: "paused", pausedReason: "应用曾中断，活动 Item 已安全放回重试队列" });
		} else if (snapshot.state === "cancelling") {
			await this.cancelRemainingItems();
			await this.store.patchQueue({ state: "cancelled", pausedReason: "上次取消已完成" });
		}
		this.publishSnapshot();
		return recovered;
	}

	async start(): Promise<void> {
		if (this.disposed) throw new Error("QueueCoordinator 已销毁");
		const snapshot = this.store.getSnapshot();
		if (TERMINAL_QUEUE_STATES.has(snapshot.state)) throw new Error(`终态队列不能重新开始：${snapshot.state}`);
		if (snapshot.state === "ready" || snapshot.state === "paused" || snapshot.state === "needs_attention") {
			await this.store.patchQueue({ state: "running", pausedReason: undefined, retryAt: undefined });
		} else if (snapshot.state !== "running") {
			throw new Error(`当前队列状态不能开始：${snapshot.state}`);
		}
		this.ensureTimer();
		this.publishSnapshot();
		await this.tick();
	}

	async pause(mode: "drain" | "immediate" = "drain"): Promise<void> {
		const snapshot = this.store.getSnapshot();
		if (snapshot.state === "paused" || snapshot.state === "pausing") return;
		if (snapshot.state !== "running") throw new Error(`当前队列状态不能暂停：${snapshot.state}`);
		await this.store.patchQueue({ state: "pausing", pausedReason: mode === "drain" ? "等待当前 Item 收尾" : "正在立即停止活动 Item" });
		this.publishSnapshot();
		if (mode === "immediate") await Promise.allSettled([...this.active.values()].map((entry) => entry.worker.abort()));
		if (this.active.size === 0) {
			await this.store.patchQueue({ state: "paused", pausedReason: "用户已暂停" });
			this.publishSnapshot();
		}
	}

	async resume(): Promise<void> {
		const snapshot = this.store.getSnapshot();
		if (snapshot.state === "needs_attention") {
			const stats = queueStats(snapshot);
			if (!stats.pending && !stats.retryWait) {
				let recovered = 0;
				for (const item of snapshot.items) {
					if (item.status !== "blocked" || item.lastError?.retryable !== true) continue;
					await this.store.patchItem(item.id, {
						status: "pending",
						lastError: undefined,
						nextAttemptAt: undefined,
						retryBudgetStartAttempt: item.attempts.length,
					});
					recovered++;
				}
				if (!recovered) throw new Error("没有可自动恢复的阻塞项；请逐条重试或说明原因后放行");
			}
		}
		await this.start();
	}

	async cancel(): Promise<void> {
		const snapshot = this.store.getSnapshot();
		if (snapshot.state === "cancelled") return;
		if (snapshot.state === "completed" || snapshot.state === "completed_with_waivers") throw new Error("已完成队列不能取消");
		if (snapshot.state !== "cancelling") await this.store.patchQueue({ state: "cancelling", pausedReason: "用户取消整批任务" });
		await this.cancelRemainingItems();
		await Promise.allSettled([...this.active.values()].map((entry) => entry.worker.abort()));
		if (this.active.size === 0) await this.store.patchQueue({ state: "cancelled" });
		this.publishSnapshot();
	}

	async retryItem(itemId: string): Promise<void> {
		const item = this.store.getSnapshot().items.find((entry) => entry.id === itemId);
		if (!item || (item.status !== "blocked" && item.status !== "waived")) throw new Error("只有 blocked/waived Item 可以人工重试");
		const updated = await this.store.patchItem(itemId, {
			status: "pending",
			waiver: undefined,
			lastError: undefined,
			nextAttemptAt: undefined,
			retryBudgetStartAttempt: item.attempts.length,
		});
		this.publishItem(updated);
	}

	async waiveItem(itemId: string, reason: string, actor = "user"): Promise<void> {
		if (reason.trim().length < 4) throw new Error("waive 必须说明原因");
		const item = this.store.getSnapshot().items.find((entry) => entry.id === itemId);
		if (!item || !["pending", "retry_wait", "blocked"].includes(item.status)) throw new Error("当前 Item 不能 waive");
		const updated = await this.store.patchItem(itemId, { status: "waived", waiver: { reason: reason.trim(), actor, at: new Date().toISOString() } });
		this.publishItem(updated);
		await this.finalizeIfIdle();
	}

	async setParallel(enabled: boolean, concurrency = 2): Promise<void> {
		const configured = enabled ? Math.max(2, Math.min(4, Math.floor(concurrency))) : 1;
		this.limiter.setConfiguredConcurrency(configured);
		const effective = this.limiter.getSnapshot().effectiveConcurrency;
		await this.store.patchQueue({ configuredConcurrency: configured, effectiveConcurrency: effective });
		this.publishSnapshot();
		if (this.store.getSnapshot().state === "running") await this.tick();
	}

	private ensureTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.tickMs);
	}

	private async tick(): Promise<void> {
		if (this.ticking || this.disposed) return;
		this.ticking = true;
		try {
			let snapshot = this.store.getSnapshot();
			if (snapshot.state === "pausing" || snapshot.state === "cancelling") {
				await this.finalizeControlState();
				return;
			}
			if (snapshot.state !== "running") return;
			const limiterState = this.limiter.getSnapshot();
			if (snapshot.effectiveConcurrency !== limiterState.effectiveConcurrency || snapshot.retryAt !== (limiterState.cooldownUntil ? new Date(limiterState.cooldownUntil).toISOString() : undefined)) {
				await this.store.patchQueue({
					effectiveConcurrency: limiterState.effectiveConcurrency,
					retryAt: limiterState.cooldownUntil > Date.now() ? new Date(limiterState.cooldownUntil).toISOString() : undefined,
				});
				snapshot = this.store.getSnapshot();
			}
			const localLimit = Math.min(snapshot.configuredConcurrency, limiterState.effectiveConcurrency);
			while (this.active.size < localLimit && this.limiter.tryAcquire()) {
				const workerId = `w-${randomUUID().slice(0, 8)}`;
				const claimed = await this.store.claimNext(workerId, this.leaseMs);
				if (!claimed) {
					this.limiter.release();
					break;
				}
				try {
					await this.launchItem(claimed, workerId);
				} catch (error) {
					this.limiter.release();
					await this.failBeforeWorker(claimed, error);
				}
			}
			await this.finalizeIfIdle();
		} finally {
			this.ticking = false;
		}
	}

	private async launchItem(claimed: QueueItem, workerId: string): Promise<void> {
		let item = await this.store.patchItem(claimed.id, { status: "running" });
		const attemptNumber = item.attempts.length + 1;
		const attemptId = `attempt-${String(attemptNumber).padStart(4, "0")}`;
		const contract = this.store.getContract();
		const input = this.store.readItemInput(item.id);
		const attempt: QueueAttemptSummary = {
			id: attemptId,
			number: attemptNumber,
			workerId,
			sessionId: attemptId,
			contractHash: contract.hash,
			promptHash: "pending",
			status: "running",
			startedAt: new Date().toISOString(),
		};
		item = await this.store.addAttempt(item.id, attempt);
		const worker = this.workerFactory({
			cwd: this.store.cwd,
			provider: this.provider,
			contract,
			item,
			input,
			workerId,
			attemptId,
		});
		worker.on?.("event", (event) => {
			if (event.kind === "text") this.ev({ kind: "queue-worker", queueId: this.store.queueId, itemId: item.id, workerId, text: event.text });
		});
		this.active.set(item.id, { itemId: item.id, workerId, attemptId, worker });
		this.publishItem(item);
		void this.executeItem(item, attemptId, worker).catch((error) => {
			this.ev({ kind: "queue-needs-attention", queueId: this.store.queueId, itemId: item.id, reason: String(error) });
		});
	}

	private async executeItem(startedItem: QueueItem, attemptId: string, worker: QueueWorkerLike): Promise<void> {
		let normalProviderCompletion = false;
		let limiterSettled = false;
		const heartbeat = setInterval(() => void this.store.heartbeat(startedItem.id, startedItem.leaseOwner || "", this.leaseMs), this.heartbeatMs);
		try {
			const output = await worker.run();
			const resultRef = this.store.writeAttemptArtifact(startedItem.id, attemptId, "result", output.result);
			await this.store.patchAttempt(startedItem.id, attemptId, { promptHash: output.promptHash, resultRef, status: "validating" });
			let item = await this.store.patchItem(startedItem.id, { status: "validating", resultRef });
			const contract = this.store.getContract();
			const validation = validateQueueRunResult(output.result, contract, { itemId: item.id, attemptId, inputDigest: item.inputDigest });
			const validationRef = this.store.writeAttemptArtifact(item.id, attemptId, "validation", validation);
			await this.store.patchAttempt(item.id, attemptId, { validationRef });
			if (!validation.passed) {
				await this.retryValidationOrBlock(item, attemptId, validation.errors.join("；"));
				normalProviderCompletion = true;
				return;
			}

			if (validation.needsSemanticReview) {
				item = await this.store.patchItem(item.id, { status: "reviewing" });
				await this.store.patchAttempt(item.id, attemptId, { status: "reviewing" });
				const review = await this.reviewer.review({ contract, item, input: this.store.readItemInput(item.id), result: output.result, validation });
				const reviewRef = this.store.writeAttemptArtifact(item.id, attemptId, "review", review);
				await this.store.patchAttempt(item.id, attemptId, { reviewRef });
				await this.applyReview(item, attemptId, review);
			} else {
				await this.markVerified(item, attemptId);
			}
			normalProviderCompletion = true;
		} catch (error) {
			const classified = classifyQueueError(error);
			if (classified.category === "rate_limit") {
				const retryAt = this.limiter.noteRateLimit();
				limiterSettled = true;
				this.ev({ kind: "queue-rate-limit", queueId: this.store.queueId, retryAt: new Date(retryAt).toISOString(), effectiveConcurrency: 1 });
			}
			await this.handleRuntimeFailure(startedItem.id, attemptId, classified);
		} finally {
			clearInterval(heartbeat);
			if (!limiterSettled) {
				if (normalProviderCompletion) this.limiter.noteSuccess();
				else this.limiter.release();
			}
			this.active.delete(startedItem.id);
			await this.syncLimiterState();
			await this.finalizeControlState();
			void this.tick();
		}
	}

	private async applyReview(item: QueueItem, attemptId: string, review: QueueReviewDecision): Promise<void> {
		if (review.verdict === "approved") return this.markVerified(item, attemptId);
		if (review.verdict === "redo") return this.retryValidationOrBlock(item, attemptId, review.redoInstruction || review.reason);
		await this.blockItem(item, attemptId, review.reason, "validation");
	}

	private async markVerified(item: QueueItem, attemptId: string): Promise<void> {
		await this.store.patchAttempt(item.id, attemptId, { status: "verified", endedAt: new Date().toISOString() });
		const updated = await this.store.patchItem(item.id, {
			status: "verified",
			leaseOwner: undefined,
			leaseUntil: undefined,
			nextAttemptAt: undefined,
			lastError: undefined,
		});
		this.publishItem(updated);
	}

	private async retryValidationOrBlock(item: QueueItem, attemptId: string, message: string): Promise<void> {
		const current = this.store.getSnapshot().items.find((entry) => entry.id === item.id);
		const attempts = (current?.attempts.length ?? 1) - (current?.retryBudgetStartAttempt ?? 0);
		const contract = this.store.getContract();
		if (attempts <= contract.maxSemanticRedos) {
			await this.retryItemAutomatically(item.id, attemptId, "validation", message, Date.now());
		} else {
			await this.blockItem(item, attemptId, message, "validation");
		}
	}

	private async handleRuntimeFailure(itemId: string, attemptId: string, classified: ReturnType<typeof classifyQueueError>): Promise<void> {
		const snapshot = this.store.getSnapshot();
		const item = snapshot.items.find((entry) => entry.id === itemId);
		if (!item) return;
		if (snapshot.state === "cancelling") {
			await this.store.patchAttempt(itemId, attemptId, { status: "cancelled", endedAt: new Date().toISOString() }).catch(() => undefined);
			const updated = await this.store.patchItem(itemId, { status: "cancelled", leaseOwner: undefined, leaseUntil: undefined });
			this.publishItem(updated);
			return;
		}
		if (snapshot.state === "pausing" && classified.category === "cancelled") {
			await this.retryItemAutomatically(itemId, attemptId, "cancelled", "用户立即暂停，当前 Item 将在恢复后重试", Date.now());
			return;
		}
		const attempts = item.attempts.length - (item.retryBudgetStartAttempt ?? 0);
		const maxRetries = this.store.getContract().maxTransientRetries;
		// 429 是外部可恢复的供给状态：只进入全局冷却，绝不能因固定次数把业务 Item 判死。
		if (classified.category === "rate_limit" || (classified.retryable && attempts <= maxRetries)) {
			const nextAt = classified.category === "rate_limit" ? this.limiter.nextAllowedAt() : Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(5, attempts - 1));
			await this.retryItemAutomatically(itemId, attemptId, classified.category, classified.message, nextAt, classified.requestId);
		} else {
			await this.blockItem(item, attemptId, classified.message, classified.category, classified.requestId, classified.retryable);
		}
	}

	private async retryItemAutomatically(itemId: string, attemptId: string, category: QueueError["category"], message: string, nextAt: number, requestId?: string): Promise<void> {
		const occurredAt = new Date().toISOString();
		const error: QueueError = { category, message, retryable: true, requestId, occurredAt };
		await this.store.patchAttempt(itemId, attemptId, { status: "failed", endedAt: occurredAt, error }).catch(() => undefined);
		const updated = await this.store.patchItem(itemId, {
			status: "retry_wait",
			leaseOwner: undefined,
			leaseUntil: undefined,
			nextAttemptAt: new Date(nextAt).toISOString(),
			lastError: error,
		});
		this.publishItem(updated);
	}

	private async blockItem(item: QueueItem, attemptId: string, message: string, category: QueueError["category"], requestId?: string, retryable = false): Promise<void> {
		const occurredAt = new Date().toISOString();
		const error: QueueError = { category, message, retryable, requestId, occurredAt };
		await this.store.patchAttempt(item.id, attemptId, { status: "failed", endedAt: occurredAt, error }).catch(() => undefined);
		const updated = await this.store.patchItem(item.id, { status: "blocked", leaseOwner: undefined, leaseUntil: undefined, lastError: error });
		this.publishItem(updated);
		this.ev({ kind: "queue-needs-attention", queueId: this.store.queueId, itemId: item.id, reason: message });
	}

	private async failBeforeWorker(item: QueueItem, error: unknown): Promise<void> {
		const classified = classifyQueueError(error);
		if (classified.category === "rate_limit") {
			const retryAt = this.limiter.noteRateLimit();
			this.ev({ kind: "queue-rate-limit", queueId: this.store.queueId, retryAt: new Date(retryAt).toISOString(), effectiveConcurrency: 1 });
		}
		const occurredAt = new Date().toISOString();
		const queueError: QueueError = { ...classified, occurredAt };
		const updated = await this.store.patchItem(item.id, {
			status: classified.retryable ? "retry_wait" : "blocked",
			leaseOwner: undefined,
			leaseUntil: undefined,
			nextAttemptAt: classified.retryable
				? new Date(classified.category === "rate_limit" ? this.limiter.nextAllowedAt() : Date.now() + 5_000).toISOString()
				: undefined,
			lastError: queueError,
		});
		this.publishItem(updated);
	}

	private async syncLimiterState(): Promise<void> {
		const state = this.limiter.getSnapshot();
		const snapshot = this.store.getSnapshot();
		const retryAt = state.cooldownUntil > Date.now() ? new Date(state.cooldownUntil).toISOString() : undefined;
		if (snapshot.effectiveConcurrency !== state.effectiveConcurrency || snapshot.retryAt !== retryAt) {
			await this.store.patchQueue({ effectiveConcurrency: state.effectiveConcurrency, retryAt });
			this.publishSnapshot();
		}
	}

	private async finalizeIfIdle(): Promise<void> {
		if (this.active.size > 0) return;
		const snapshot = this.store.getSnapshot();
		if (!["ready", "running", "paused", "needs_attention"].includes(snapshot.state)) return;
		const stats = queueStats(snapshot);
		if (stats.pending || stats.running || stats.retryWait) return;
		if (stats.verified === stats.total) await this.store.patchQueue({ state: "completed", retryAt: undefined });
		else if (stats.verified + stats.waived === stats.total) await this.store.patchQueue({ state: "completed_with_waivers", retryAt: undefined });
		else if (snapshot.state === "running") await this.store.patchQueue({ state: "needs_attention", pausedReason: "存在 blocked/cancelled Item，需要人工处理" });
		else return;
		this.publishSnapshot();
	}

	private async finalizeControlState(): Promise<void> {
		if (this.active.size > 0) return;
		const snapshot = this.store.getSnapshot();
		if (snapshot.state === "pausing") {
			await this.store.patchQueue({ state: "paused", pausedReason: "用户已暂停" });
			this.publishSnapshot();
		} else if (snapshot.state === "cancelling") {
			await this.cancelRemainingItems();
			await this.store.patchQueue({ state: "cancelled" });
			this.publishSnapshot();
		}
	}

	private async cancelRemainingItems(): Promise<void> {
		for (const item of this.store.getSnapshot().items) {
			if (["pending", "retry_wait", "blocked", "leased"].includes(item.status)) {
				const updated = await this.store.patchItem(item.id, { status: "cancelled", leaseOwner: undefined, leaseUntil: undefined });
				this.publishItem(updated);
			}
		}
	}

	waitForSettled(timeoutMs = 30_000): Promise<QueueSnapshot> {
		const current = this.store.getSnapshot();
		if (TERMINAL_QUEUE_STATES.has(current.state) || current.state === "needs_attention") return Promise.resolve(current);
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.off("event", listener);
				reject(new Error(`等待队列结束超时（${timeoutMs}ms）`));
			}, timeoutMs);
			const listener = (event: QueueWireEvent) => {
				if (event.kind !== "queue-snapshot") return;
				if (!TERMINAL_QUEUE_STATES.has(event.snapshot.state) && event.snapshot.state !== "needs_attention") return;
				clearTimeout(timeout);
				this.off("event", listener);
				resolve(event.snapshot);
			};
			this.on("event", listener);
		});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await Promise.allSettled([...this.active.values()].map((entry) => entry.worker.abort()));
	}
}
