import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueCoordinator } from "../src/queue-coordinator.ts";
import { ProviderLimiter } from "../src/provider-limiter.ts";
import { QueueStore } from "../src/queue-store.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (read, expected, timeout = 3_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = read();
    if (value === expected) return;
    await delay(10);
  }
  throw new Error(`等待状态 ${expected} 超时，当前 ${read()}`);
};

const contractSpec = (overrides = {}) => ({
  primaryGoal: "逐条验证记录",
  requirements: ["每条隔离", "不可猜测"],
  skills: [{ name: "workflow", instructions: "每次只处理一条" }],
  inputSchema: { type: "object" },
  outputSchema: { type: "object", required: ["itemId", "attemptId", "contractHash", "inputDigest", "skillUsage"] },
  itemPromptTemplate: "核验 {{source_key}}",
  deterministicChecks: [{ id: "no-unresolved", type: "require-no-unresolved" }],
  semanticReviewPolicy: "never",
  maxSemanticRedos: 1,
  maxTransientRetries: 2,
  ...overrides,
});

const validResult = (options) => ({
  itemId: options.item.id,
  attemptId: options.attemptId,
  contractHash: options.contract.hash,
  inputDigest: options.item.inputDigest,
  outcome: "no_change",
  observations: [], changes: [], evidence: [], unresolved: [],
  skillUsage: options.contract.skills.map(({ name, sha256 }) => ({ name, sha256 })),
});

const fastLimiter = () => {
  let inFlight = 0;
  let cooldownUntil = 0;
  return {
    tryAcquire() { if (inFlight || Date.now() < cooldownUntil) return false; inFlight++; return true; },
    release() { inFlight = Math.max(0, inFlight - 1); },
    noteSuccess() { this.release(); },
    noteRateLimit() { this.release(); cooldownUntil = Date.now() + 2; return cooldownUntil; },
    nextAllowedAt() { return cooldownUntil; },
    setConfiguredConcurrency() {},
    getSnapshot() { return { key: "fast", configuredConcurrency: 1, effectiveConcurrency: 1, inFlight, cooldownUntil, consecutiveSuccesses: 0, rateLimitCount: 0 }; },
  };
};

// 40 条并行消费：并发不越界，每条只验证一次。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-coordinator-"));
  const store = QueueStore.create(work, contractSpec(), Array.from({ length: 40 }, (_, i) => ({ sourceKey: `row-${i + 1}`, payload: { id: i + 1 } })), { queueId: "parallel", configuredConcurrency: 4 });
  let active = 0, maxActive = 0;
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "parallel",
    tickMs: 5,
    heartbeatMs: 1_000,
    limiter: new ProviderLimiter("parallel", { configuredConcurrency: 4 }),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: (options) => ({
      async run() {
        active++; maxActive = Math.max(maxActive, active);
        await delay(3);
        active--;
        return { result: validResult(options), rawText: "", sessionId: options.attemptId, promptHash: `p-${options.item.id}` };
      },
      async abort() {},
    }),
  });
  await coordinator.start();
  const done = await coordinator.waitForSettled(8_000);
  assert.equal(done.state, "completed");
  assert.equal(done.items.every((item) => item.status === "verified"), true);
  assert.equal(done.items.every((item) => item.attempts.length === 1), true);
  assert.ok(maxActive > 1 && maxActive <= 4, `最大并发应在 2-4，实际 ${maxActive}`);
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

// 429 是供应端暂态，不受“普通瞬时重试次数”限制；冷却后必须继续当前 Item，而不是停掉整批。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-429-"));
  QueueStore.create(work, contractSpec({ maxTransientRetries: 1 }), [{ sourceKey: "row-1", payload: { id: 1 } }], { queueId: "rate-limit" });
  let calls = 0;
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "rate-limit",
    tickMs: 2,
    limiter: fastLimiter(),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: (options) => ({
      async run() {
        calls++;
        if (calls <= 5) throw new Error(`429 Requests are too frequent. Request id: req-${calls}`);
        return { result: validResult(options), rawText: "", sessionId: options.attemptId, promptHash: `p-${options.attemptId}` };
      },
      async abort() {},
    }),
  });
  await coordinator.start();
  const done = await coordinator.waitForSettled(5_000);
  assert.equal(done.state, "completed");
  assert.equal(done.items[0].attempts.length, 6, "超过普通重试预算的 429 仍应继续");
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

// 普通可恢复错误耗尽自动预算后进入 needs_attention；用户点“重试可恢复项”必须真正重新入队。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-resume-"));
  QueueStore.create(work, contractSpec({ maxTransientRetries: 0 }), [{ sourceKey: "row-1", payload: { id: 1 } }], { queueId: "resume" });
  let calls = 0;
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "resume",
    tickMs: 2,
    limiter: fastLimiter(),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: (options) => ({
      async run() {
        calls++;
        if (calls === 1) throw new Error("network timeout");
        return { result: validResult(options), rawText: "", sessionId: options.attemptId, promptHash: `p-${options.attemptId}` };
      },
      async abort() {},
    }),
  });
  await coordinator.start();
  await waitFor(() => coordinator.getSnapshot().state, "needs_attention");
  assert.equal(coordinator.getSnapshot().items[0].lastError.retryable, true);
  await coordinator.resume();
  const done = await coordinator.waitForSettled(5_000);
  assert.equal(done.state, "completed");
  assert.equal(done.items[0].attempts.length, 2);
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

// 第一次结构化结果错误，自动生成新 session 重试；第二次通过。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-retry-"));
  QueueStore.create(work, contractSpec(), [{ sourceKey: "row-1", payload: { id: 1 } }], { queueId: "retry" });
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "retry",
    tickMs: 5,
    limiter: new ProviderLimiter("retry", { configuredConcurrency: 1 }),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: (options) => ({
      async run() {
        const result = validResult(options);
        if (options.item.attempts.length === 1) result.contractHash = "wrong";
        return { result, rawText: "", sessionId: options.attemptId, promptHash: `p-${options.attemptId}` };
      },
      async abort() {},
    }),
  });
  await coordinator.start();
  const done = await coordinator.waitForSettled(5_000);
  assert.equal(done.state, "completed");
  assert.equal(done.items[0].attempts.length, 2);
  assert.match(done.items[0].attempts[0].error.message, /contractHash/);
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

// 立即暂停会 abort 当前 Item，并把它放回 retry_wait；恢复后可继续。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-pause-"));
  QueueStore.create(work, contractSpec(), [{ sourceKey: "row-1", payload: { id: 1 } }], { queueId: "pause" });
  let rejectRun;
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "pause",
    tickMs: 5,
    limiter: new ProviderLimiter("pause", { configuredConcurrency: 1 }),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: () => ({
      run: () => new Promise((_resolve, reject) => { rejectRun = reject; }),
      abort: async () => rejectRun?.(new Error("QueueItem 已取消")),
    }),
  });
  await coordinator.start();
  await waitFor(() => coordinator.getSnapshot().items[0].status, "running");
  await coordinator.pause("immediate");
  await waitFor(() => coordinator.getSnapshot().state, "paused");
  assert.equal(coordinator.getSnapshot().items[0].status, "retry_wait");
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

// needs_attention 里的最后一个阻塞项经用户明确放行后，队列必须自动收口，不能永远卡在“需要处理”。
{
  const work = mkdtempSync(join(tmpdir(), "gm-queue-waive-"));
  QueueStore.create(work, contractSpec({ maxTransientRetries: 0 }), [{ sourceKey: "row-1", payload: { id: 1 } }], { queueId: "waive" });
  const coordinator = new QueueCoordinator({
    cwd: work,
    queueId: "waive",
    tickMs: 5,
    limiter: new ProviderLimiter("waive", { configuredConcurrency: 1 }),
    reviewer: { review: async () => { throw new Error("never 模式不应调用 reviewer"); } },
    workerFactory: () => ({ run: async () => { throw new Error("不可恢复的业务错误"); }, abort: async () => {} }),
  });
  await coordinator.start();
  await waitFor(() => coordinator.getSnapshot().state, "needs_attention");
  assert.equal(coordinator.getSnapshot().items[0].status, "blocked");
  await coordinator.waiveItem("item-000001", "用户已人工核对并接受此条缺失");
  assert.equal(coordinator.getSnapshot().state, "completed_with_waivers");
  await coordinator.dispose();
  rmSync(work, { recursive: true, force: true });
}

console.log("✅ QueueCoordinator：受控并发、429 持续退避、人工恢复、立即暂停与状态聚合通过");
