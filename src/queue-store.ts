import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
	QUEUE_SCHEMA_VERSION,
	type QueueAttemptPatch,
	type QueueAttemptSummary,
	type QueueContract,
	type QueueContractSpec,
	type QueueCreateOptions,
	type QueueEvent,
	type QueueItem,
	type QueueItemInput,
	type QueueItemPatch,
	type QueueItemStatus,
	type QueueMutablePatch,
	type QueueSnapshot,
	type QueueState,
	type QueueStats,
} from "./queue-types.ts";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;
const ACTIVE_ITEM_STATES = new Set<QueueItemStatus>(["leased", "running", "validating", "reviewing"]);

const QUEUE_TRANSITIONS: Record<QueueState, ReadonlySet<QueueState>> = {
	draft: new Set(["ready", "cancelling", "cancelled"]),
	ready: new Set(["running", "cancelling", "cancelled", "completed_with_waivers"]),
	running: new Set(["pausing", "paused", "needs_attention", "cancelling", "completed", "completed_with_waivers"]),
	pausing: new Set(["paused", "running", "cancelling"]),
	paused: new Set(["running", "cancelling", "cancelled", "completed", "completed_with_waivers"]),
	needs_attention: new Set(["running", "paused", "cancelling", "completed", "completed_with_waivers"]),
	cancelling: new Set(["cancelled"]),
	cancelled: new Set(),
	completed: new Set(),
	completed_with_waivers: new Set(),
};

const ITEM_TRANSITIONS: Record<QueueItemStatus, ReadonlySet<QueueItemStatus>> = {
	pending: new Set(["leased", "cancelled", "waived"]),
	leased: new Set(["running", "pending", "retry_wait", "cancelled"]),
	running: new Set(["validating", "retry_wait", "blocked", "cancelled"]),
	validating: new Set(["reviewing", "verified", "retry_wait", "blocked", "cancelled"]),
	reviewing: new Set(["running", "verified", "retry_wait", "blocked", "cancelled"]),
	retry_wait: new Set(["pending", "leased", "cancelled", "waived"]),
	verified: new Set(),
	blocked: new Set(["pending", "cancelled", "waived"]),
	waived: new Set(["pending"]),
	cancelled: new Set(),
};

function assertSafeId(id: string, label: string): void {
	if (!SAFE_ID.test(id)) throw new Error(`${label} 非法：${id}`);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableValue(v)]));
	}
	return value;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

export function sha256(value: unknown): string {
	const text = typeof value === "string" ? value : stableJson(value);
	return createHash("sha256").update(text).digest("hex");
}

function atomicWriteJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, file);
}

function durableAppend(file: string, line: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const fd = openSync(file, "a", 0o600);
	try {
		writeSync(fd, line);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertQueueTransition(from: QueueState, to: QueueState): void {
	if (from === to) return;
	if (!QUEUE_TRANSITIONS[from].has(to)) throw new Error(`非法队列状态迁移：${from} -> ${to}`);
}

function assertItemTransition(from: QueueItemStatus, to: QueueItemStatus): void {
	if (from === to) return;
	if (!ITEM_TRANSITIONS[from].has(to)) throw new Error(`非法 Item 状态迁移：${from} -> ${to}`);
}

function applyEvent(current: QueueSnapshot | undefined, event: QueueEvent): QueueSnapshot {
	if (event.type === "queue-created") {
		if (current) throw new Error("队列已经创建，不能重复应用 queue-created");
		return { ...clone(event.snapshot), seq: event.seq, updatedAt: event.at };
	}
	if (!current) throw new Error(`缺少 queue-created，无法应用 ${event.type}`);
	if (event.seq <= current.seq) return current;
	if (event.seq !== current.seq + 1) throw new Error(`队列事件 seq 不连续：当前 ${current.seq}，收到 ${event.seq}`);

	const next = clone(current);
	if (event.type === "queue-patched") {
		if (event.patch.state) assertQueueTransition(next.state, event.patch.state);
		Object.assign(next, event.patch);
	} else {
		const item = next.items.find((entry) => entry.id === event.itemId);
		if (!item) throw new Error(`找不到 Item：${event.itemId}`);
		if (event.type === "item-patched") {
			if (item.version !== event.expectedVersion) throw new Error(`Item ${item.id} 版本冲突：期望 ${event.expectedVersion}，实际 ${item.version}`);
			if (event.patch.status) assertItemTransition(item.status, event.patch.status);
			Object.assign(item, event.patch);
			item.version++;
		} else if (event.type === "attempt-added") {
			if (item.version !== event.expectedVersion) throw new Error(`Item ${item.id} 版本冲突：期望 ${event.expectedVersion}，实际 ${item.version}`);
			if (item.attempts.some((attempt) => attempt.id === event.attempt.id)) throw new Error(`Attempt 已存在：${event.attempt.id}`);
			item.attempts.push(clone(event.attempt));
			item.activeAttemptId = event.attempt.id;
			item.version++;
		} else {
			const attempt = item.attempts.find((entry) => entry.id === event.attemptId);
			if (!attempt) throw new Error(`找不到 Attempt：${event.attemptId}`);
			Object.assign(attempt, event.patch);
		}
	}
	next.seq = event.seq;
	next.updatedAt = event.at;
	return next;
}

function parseEvents(file: string): QueueEvent[] {
	if (!existsSync(file)) return [];
	const raw = readFileSync(file, "utf8");
	const lines = raw.split("\n");
	const events: QueueEvent[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			events.push(JSON.parse(line) as QueueEvent);
		} catch (error) {
			const isTrailingFragment = i === lines.length - 1 && !raw.endsWith("\n");
			if (!isTrailingFragment) throw new Error(`队列事件日志第 ${i + 1} 行损坏：${String(error)}`);
		}
	}
	return events;
}

export function queueRoot(cwd: string): string {
	return join(cwd, ".goal-mode-pi", "queues");
}

export function queueDir(cwd: string, queueId: string): string {
	assertSafeId(queueId, "queueId");
	return join(queueRoot(cwd), queueId);
}

export function listQueueIds(cwd: string): string[] {
	try {
		return readdirSync(queueRoot(cwd), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function queueIdNow(): string {
	return `q-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function normalizeContract(queueId: string, spec: QueueContractSpec, now: string): QueueContract {
	const skills = spec.skills.map((skill) => ({
		name: skill.name.trim(),
		instructions: skill.instructions,
		sha256: skill.sha256 || sha256(skill.instructions),
	}));
	const unsigned = {
		queueId,
		version: 1,
		createdAt: now,
		...spec,
		maxSemanticRedos: Math.max(0, Math.floor(Number(spec.maxSemanticRedos) || 0)),
		maxTransientRetries: Math.max(0, Math.floor(Number(spec.maxTransientRetries) || 0)),
		itemTimeoutMs: Math.max(0, Math.floor(Number(spec.itemTimeoutMs) || 0)),
		skills,
	};
	return { ...unsigned, hash: sha256(unsigned) };
}

export function queueStats(snapshot: QueueSnapshot): QueueStats {
	const stats: QueueStats = {
		total: snapshot.items.length,
		pending: 0,
		running: 0,
		retryWait: 0,
		verified: 0,
		blocked: 0,
		waived: 0,
		cancelled: 0,
		progress: 0,
	};
	for (const item of snapshot.items) {
		if (item.status === "pending" || item.status === "leased") stats.pending++;
		else if (item.status === "running" || item.status === "validating" || item.status === "reviewing") stats.running++;
		else if (item.status === "retry_wait") stats.retryWait++;
		else if (item.status === "verified") stats.verified++;
		else if (item.status === "blocked") stats.blocked++;
		else if (item.status === "waived") stats.waived++;
		else if (item.status === "cancelled") stats.cancelled++;
	}
	stats.progress = stats.total ? Math.round(((stats.verified + stats.waived) / stats.total) * 10_000) / 100 : 0;
	return stats;
}

export class QueueStore {
	readonly cwd: string;
	readonly queueId: string;
	readonly dir: string;
	private snapshot?: QueueSnapshot;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(cwd: string, queueId: string) {
		assertSafeId(queueId, "queueId");
		this.cwd = cwd;
		this.queueId = queueId;
		this.dir = queueDir(cwd, queueId);
		this.hydrate();
	}

	static create(cwd: string, contractSpec: QueueContractSpec, inputs: QueueItemInput[], options: QueueCreateOptions = {}): QueueStore {
		if (!inputs.length) throw new Error("队列至少需要一个 Item");
		const queueId = options.queueId || queueIdNow();
		assertSafeId(queueId, "queueId");
		const dir = queueDir(cwd, queueId);
		if (existsSync(join(dir, "events.jsonl")) || existsSync(join(dir, "snapshot.json"))) throw new Error(`队列已存在：${queueId}`);
		const now = new Date().toISOString();
		const contract = normalizeContract(queueId, contractSpec, now);
		const configuredConcurrency = Math.max(1, Math.min(4, Math.floor(options.configuredConcurrency ?? 1)));
		const seenIds = new Set<string>();
		const seenSourceKeys = new Set<string>();
		const items: QueueItem[] = inputs.map((input, index) => {
			const id = input.id || `item-${String(index + 1).padStart(6, "0")}`;
			assertSafeId(id, "itemId");
			if (seenIds.has(id)) throw new Error(`Item id 重复：${id}`);
			seenIds.add(id);
			const sourceKey = input.sourceKey.trim();
			if (!sourceKey) throw new Error(`Item ${id} 缺少 sourceKey`);
			if (seenSourceKeys.has(sourceKey)) throw new Error(`sourceKey 重复：${sourceKey}`);
			seenSourceKeys.add(sourceKey);
			const inputRef = join("items", id, "input.json");
			atomicWriteJson(join(dir, inputRef), input.payload);
			return {
				id,
				sourceKey,
				inputRef,
				inputDigest: sha256(input.payload),
				status: "pending",
				attempts: [],
				version: 0,
			};
		});
		atomicWriteJson(join(dir, "contract.json"), contract);
		const snapshot: Omit<QueueSnapshot, "seq" | "updatedAt"> = {
			schemaVersion: QUEUE_SCHEMA_VERSION,
			id: queueId,
			cwd,
			title: options.title?.trim() || contract.primaryGoal.slice(0, 80) || "批处理队列",
			state: "ready",
			contractVersion: contract.version,
			contractHash: contract.hash,
			configuredConcurrency,
			effectiveConcurrency: configuredConcurrency,
			items,
			createdAt: now,
		};
		const store = new QueueStore(cwd, queueId);
		store.commitSync({ seq: 1, at: now, type: "queue-created", snapshot });
		return store;
	}

	private hydrate(): void {
		let current: QueueSnapshot | undefined;
		try {
			const saved = JSON.parse(readFileSync(join(this.dir, "snapshot.json"), "utf8")) as QueueSnapshot;
			if (saved.schemaVersion === QUEUE_SCHEMA_VERSION && saved.id === this.queueId) current = saved;
		} catch {
			current = undefined;
		}
		for (const event of parseEvents(join(this.dir, "events.jsonl"))) {
			if (current && event.seq <= current.seq) continue;
			current = applyEvent(current, event);
		}
		this.snapshot = current;
	}

	private requireSnapshot(): QueueSnapshot {
		if (!this.snapshot) throw new Error(`队列不存在或未初始化：${this.queueId}`);
		return this.snapshot;
	}

	private commitSync(event: QueueEvent): QueueSnapshot {
		const next = applyEvent(this.snapshot, event);
		durableAppend(join(this.dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
		this.snapshot = next;
		atomicWriteJson(join(this.dir, "snapshot.json"), next);
		return clone(next);
	}

	private enqueue<T>(operation: () => T): Promise<T> {
		const result = this.writeChain.then(operation, operation);
		this.writeChain = result.then(() => undefined, () => undefined);
		return result;
	}

	getSnapshot(): QueueSnapshot {
		return clone(this.requireSnapshot());
	}

	getContract(): QueueContract {
		const contract = JSON.parse(readFileSync(join(this.dir, "contract.json"), "utf8")) as QueueContract;
		if (contract.hash !== this.requireSnapshot().contractHash) throw new Error("QueueContract hash 与队列快照不一致");
		return contract;
	}

	readItemInput(itemId: string): unknown {
		assertSafeId(itemId, "itemId");
		const item = this.requireSnapshot().items.find((entry) => entry.id === itemId);
		if (!item) throw new Error(`找不到 Item：${itemId}`);
		const input = JSON.parse(readFileSync(join(this.dir, item.inputRef), "utf8")) as unknown;
		if (sha256(input) !== item.inputDigest) throw new Error(`Item ${itemId} 输入摘要不一致`);
		return input;
	}

	patchQueue(patch: QueueMutablePatch): Promise<QueueSnapshot> {
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const event: QueueEvent = { seq: current.seq + 1, at: new Date().toISOString(), type: "queue-patched", patch };
			return this.commitSync(event);
		});
	}

	patchItem(itemId: string, patch: QueueItemPatch, expectedVersion?: number): Promise<QueueItem> {
		assertSafeId(itemId, "itemId");
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const item = current.items.find((entry) => entry.id === itemId);
			if (!item) throw new Error(`找不到 Item：${itemId}`);
			const event: QueueEvent = {
				seq: current.seq + 1,
				at: new Date().toISOString(),
				type: "item-patched",
				itemId,
				expectedVersion: expectedVersion ?? item.version,
				patch,
			};
			return this.commitSync(event).items.find((entry) => entry.id === itemId)!;
		});
	}

	addAttempt(itemId: string, attempt: QueueAttemptSummary): Promise<QueueItem> {
		assertSafeId(itemId, "itemId");
		assertSafeId(attempt.id, "attemptId");
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const item = current.items.find((entry) => entry.id === itemId);
			if (!item) throw new Error(`找不到 Item：${itemId}`);
			const event: QueueEvent = {
				seq: current.seq + 1,
				at: new Date().toISOString(),
				type: "attempt-added",
				itemId,
				expectedVersion: item.version,
				attempt,
			};
			return this.commitSync(event).items.find((entry) => entry.id === itemId)!;
		});
	}

	patchAttempt(itemId: string, attemptId: string, patch: QueueAttemptPatch): Promise<QueueItem> {
		assertSafeId(itemId, "itemId");
		assertSafeId(attemptId, "attemptId");
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const event: QueueEvent = {
				seq: current.seq + 1,
				at: new Date().toISOString(),
				type: "attempt-patched",
				itemId,
				attemptId,
				patch,
			};
			return this.commitSync(event).items.find((entry) => entry.id === itemId)!;
		});
	}

	claimNext(owner: string, leaseMs: number, now = Date.now()): Promise<QueueItem | undefined> {
		assertSafeId(owner, "workerId");
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const item = current.items.find((entry) =>
				entry.status === "pending" || (entry.status === "retry_wait" && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now)),
			);
			if (!item) return undefined;
			const event: QueueEvent = {
				seq: current.seq + 1,
				at: new Date(now).toISOString(),
				type: "item-patched",
				itemId: item.id,
				expectedVersion: item.version,
				patch: {
					status: "leased",
					leaseOwner: owner,
					leaseUntil: new Date(now + Math.max(1_000, leaseMs)).toISOString(),
					nextAttemptAt: undefined,
				},
			};
			return this.commitSync(event).items.find((entry) => entry.id === item.id);
		});
	}

	heartbeat(itemId: string, owner: string, leaseMs: number, now = Date.now()): Promise<boolean> {
		return this.enqueue(() => {
			const current = this.requireSnapshot();
			const item = current.items.find((entry) => entry.id === itemId);
			if (!item || item.leaseOwner !== owner || !ACTIVE_ITEM_STATES.has(item.status)) return false;
			const event: QueueEvent = {
				seq: current.seq + 1,
				at: new Date(now).toISOString(),
				type: "item-patched",
				itemId,
				expectedVersion: item.version,
				patch: { leaseUntil: new Date(now + Math.max(1_000, leaseMs)).toISOString() },
			};
			this.commitSync(event);
			return true;
		});
	}

	recoverExpired(now = Date.now()): Promise<number> {
		return this.recoverActive(false, now);
	}

	/** 应用重启时 worker 已全部消失，忽略尚未到期的租约，把活动项安全放回重试队列。 */
	recoverAfterRestart(now = Date.now()): Promise<number> {
		return this.recoverActive(true, now);
	}

	private recoverActive(force: boolean, now: number): Promise<number> {
		return this.enqueue(() => {
			let count = 0;
			for (const itemId of this.requireSnapshot().items
				.filter((item) => ACTIVE_ITEM_STATES.has(item.status) && (force || !item.leaseUntil || Date.parse(item.leaseUntil) <= now))
				.map((item) => item.id)) {
				const current = this.requireSnapshot();
				const item = current.items.find((entry) => entry.id === itemId)!;
				const at = new Date(now).toISOString();
				const event: QueueEvent = {
					seq: current.seq + 1,
					at,
					type: "item-patched",
					itemId,
					expectedVersion: item.version,
					patch: {
						status: "retry_wait",
						leaseOwner: undefined,
						leaseUntil: undefined,
						nextAttemptAt: at,
						lastError: { category: "worker_crash", message: "worker 租约过期，等待安全重试", retryable: true, occurredAt: at },
					},
				};
				this.commitSync(event);
				count++;
			}
			return count;
		});
	}

	writeAttemptArtifact(itemId: string, attemptId: string, name: "result" | "validation" | "review", value: unknown): string {
		assertSafeId(itemId, "itemId");
		assertSafeId(attemptId, "attemptId");
		const relative = join("items", itemId, "attempts", attemptId, `${name}.json`);
		atomicWriteJson(join(this.dir, relative), value);
		return relative;
	}

	/** 测试和明确删除草稿时使用；运行中的队列不应调用。 */
	destroy(): void {
		rmSync(this.dir, { recursive: true, force: true });
		this.snapshot = undefined;
	}
}
