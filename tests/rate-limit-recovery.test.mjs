import assert from "node:assert/strict";
import { RateLimitRecovery, RATE_LIMIT_RESUME_PROMPT } from "../src/rate-limit-recovery.ts";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waits = [];
const retries = [];
const recovery = new RateLimitRecovery({
  onWait: (delayMs, attempt, requestId) => waits.push({ delayMs, attempt, requestId }),
  onRetry: (attempt) => retries.push(attempt),
}, { baseDelayMs: 5, maxDelayMs: 20 });

recovery.observeTerminal("Error: 429 Requests are too frequent. Request id: req-123\r\n");
assert.equal(waits.length, 0, "Pi 自带重试尚未结束时不能抢着重复提交");
recovery.observeTerminal("Error: Retry failed after 1 attempts: Retry cancelled\r\n");
assert.deepEqual(waits, [{ delayMs: 5, attempt: 1, requestId: "req-123" }]);
await delay(12);
assert.deepEqual(retries, [1]);

recovery.observeTerminal("429 rate limit\nRetry failed after 3 attempts\n");
assert.equal(waits.at(-1).delayMs, 10, "连续限流应指数退避");
recovery.cancel();
await delay(15);
assert.deepEqual(retries, [1], "用户 Esc 后计划中的自动恢复必须取消");
recovery.observeTerminal("429 rate limit\nRetry failed after 3 attempts\n");
await delay(8);
assert.deepEqual(retries, [1], "取消后不能被迟到的终端错误重新唤醒");

recovery.reset();
recovery.observeTerminal("\u001b[31m429 too many requests\u001b[0m\nRetry failed after 3 attempts\n");
await delay(8);
assert.deepEqual(retries, [1, 1], "下一条真实用户任务应重新允许恢复，且退避代际重置");
recovery.reset();
recovery.observeTerminal("Auto-compaction failed: Summarization failed: 429 Requests are too frequent\n");
await delay(8);
assert.deepEqual(retries, [1, 1, 1], "429 导致的压缩失败也必须从原任务断点恢复");
assert.match(RATE_LIMIT_RESUME_PROMPT, /继续上一条尚未完成的用户任务/);
console.log("✅ 实时 429 恢复：等待原生重试结束、指数退避、自动续跑与 Esc 取消通过");
