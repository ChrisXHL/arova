import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore, queueStats, sha256 } from "../src/queue-store.ts";

const work = mkdtempSync(join(tmpdir(), "gm-queue-store-"));
const contract = {
  primaryGoal: "逐条核验记录",
  requirements: ["每条独立处理", "不可猜测"],
  skills: [{ name: "workflow", instructions: "逐条执行并验证" }],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  itemPromptTemplate: "处理 {{item}}",
  deterministicChecks: [{ id: "shape", type: "schema" }],
  semanticReviewPolicy: "when_needed",
  maxSemanticRedos: 2,
  maxTransientRetries: 5,
};

const inputs = Array.from({ length: 500 }, (_, index) => ({ sourceKey: `row-${index + 1}`, payload: { id: index + 1, value: `v${index + 1}` } }));
const store = QueueStore.create(work, contract, inputs, { queueId: "queue-a", configuredConcurrency: 4 });
let snapshot = store.getSnapshot();
assert.equal(snapshot.items.length, 500);
assert.equal(snapshot.state, "ready");
assert.equal(snapshot.configuredConcurrency, 4);
assert.equal(store.getContract().skills[0].sha256, sha256("逐条执行并验证"));
assert.deepEqual(store.readItemInput("item-000001"), { id: 1, value: "v1" });

const first = await store.claimNext("worker-a", 60_000, 1_000);
const second = await store.claimNext("worker-b", 60_000, 1_000);
assert.equal(first?.id, "item-000001");
assert.equal(second?.id, "item-000002");
assert.notEqual(first?.id, second?.id, "并发领取不能拿到同一 Item");

await store.patchItem(first.id, { status: "running" });
await store.addAttempt(first.id, {
  id: "attempt-1",
  number: 1,
  workerId: "worker-a",
  sessionId: "session-1",
  contractHash: snapshot.contractHash,
  promptHash: "prompt-hash",
  status: "running",
  startedAt: new Date(1_000).toISOString(),
});
await store.patchItem(first.id, { status: "validating" });
await store.patchAttempt(first.id, "attempt-1", { status: "validating" });
await store.patchItem(first.id, { status: "verified", leaseOwner: undefined, leaseUntil: undefined });
await store.patchAttempt(first.id, "attempt-1", { status: "verified", endedAt: new Date(2_000).toISOString() });

await store.patchItem(second.id, { status: "running", leaseUntil: new Date(500).toISOString() });
assert.equal(await store.recoverExpired(1_000), 1);
snapshot = store.getSnapshot();
assert.equal(snapshot.items[1].status, "retry_wait");
assert.equal(snapshot.items[1].lastError?.category, "worker_crash");
assert.equal(queueStats(snapshot).verified, 1);

const persistedSeq = snapshot.seq;
const reloaded = new QueueStore(work, "queue-a");
assert.equal(reloaded.getSnapshot().seq, persistedSeq);
assert.equal(reloaded.getSnapshot().items[0].status, "verified");

// 快照损坏/丢失时，完整事件日志仍能重放恢复。
unlinkSync(join(work, ".goal-mode-pi", "queues", "queue-a", "snapshot.json"));
const replayed = new QueueStore(work, "queue-a");
assert.equal(replayed.getSnapshot().seq, persistedSeq);
assert.equal(replayed.getSnapshot().items[1].status, "retry_wait");

// 尾部半行模拟突然断电：忽略未完成尾行，之前事件仍然有效。
const eventsFile = join(work, ".goal-mode-pi", "queues", "queue-a", "events.jsonl");
writeFileSync(eventsFile, readFileSync(eventsFile, "utf8") + '{"seq":999');
const tailRecovered = new QueueStore(work, "queue-a");
assert.equal(tailRecovered.getSnapshot().seq, persistedSeq);

await assert.rejects(() => store.patchItem(first.id, { status: "pending" }), /非法 Item 状态迁移/);
rmSync(work, { recursive: true, force: true });
console.log("✅ QueueStore：500 Item、原子事件重放、领取隔离、租约恢复与状态门通过");
