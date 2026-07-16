import assert from "node:assert/strict";
import { ProviderLimiter } from "../src/provider-limiter.ts";

let now = 1_000;
const limiter = new ProviderLimiter("provider:model", { configuredConcurrency: 4, now: () => now, random: () => 0 });
assert.equal(limiter.tryAcquire(), true);
assert.equal(limiter.tryAcquire(), true);
assert.equal(limiter.tryAcquire(), true);
assert.equal(limiter.tryAcquire(), true);
assert.equal(limiter.tryAcquire(), false);

const retryAt = limiter.noteRateLimit(undefined, now);
assert.equal(limiter.getSnapshot().effectiveConcurrency, 1);
assert.equal(retryAt, now + 15_000, "full jitter 下界应为 base 的 50%");
limiter.release(); limiter.release(); limiter.release();
assert.equal(limiter.tryAcquire(now + 14_999), false);
now = retryAt;
for (let i = 0; i < 10; i++) {
  assert.equal(limiter.tryAcquire(), true);
  limiter.noteSuccess();
}
assert.equal(limiter.getSnapshot().effectiveConcurrency, 2, "连续成功后只能缓慢增加 1");
console.log("✅ ProviderLimiter：429 共享冷却、降并发和 AIMD 恢复通过");

