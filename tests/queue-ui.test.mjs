import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "renderer/index.html"), "utf8");
const renderer = readFileSync(join(root, "renderer/app.js"), "utf8");
const server = readFileSync(join(root, "src/server.ts"), "utf8");
const policy = readFileSync(join(root, "src/policy.ts"), "utf8");
execFileSync(process.execPath, ["--check", join(root, "renderer/app.js")], { stdio: "pipe" });

for (const id of ["newQueueBtn", "queueGoal", "queuePrompt", "queueItems", "queueParallel", "queueConcurrency", "queueSemanticRedos", "queueTransientRetries", "queueItemTimeoutMinutes", "projectQueues"]) {
  assert.match(html, new RegExp(`id="${id}"`), `项目页缺少 ${id}`);
}
assert.match(renderer, /function parseQueueItems\(raw\)/, "必须能把行或 JSON 数组变成 Item");
assert.match(renderer, /function queueAction\(queueId, action/, "队列控制必须走统一 API");
assert.match(renderer, /pause", \{ mode: "drain" \}/, "必须支持当前 Item 收尾后暂停");
assert.match(renderer, /pause", \{ mode: "immediate" \}/, "必须支持立即暂停");
assert.match(renderer, /items\/\$\{item\.id\}\/retry/, "阻塞 Item 必须可人工重试");
assert.match(renderer, /items\/\$\{item\.id\}\/waive/, "阻塞 Item 必须可说明原因后放行");
assert.match(renderer, /实际 \$\{queue\.effectiveConcurrency \|\| 1\}/, "UI 必须区分配置并发和限流后的实际并发");
assert.match(renderer, /重试可恢复项/, "needs_attention 的继续按钮必须真正恢复可重试项");
assert.match(server, /url\.pathname === "\/queues"/, "服务端必须提供队列 API");
assert.match(server, /recoverPersistedQueue/, "应用重启后的首次访问必须恢复中断队列");
assert.doesNotMatch(server, /sweepQueueZombies/, "冷启动不能扫描所有项目的全部队列");
assert.match(server, /snapshot: \{ \.\.\.event\.snapshot, items: \[\] \}/, "SSE 只能推队列摘要，不能每次广播几百条完整快照");
assert.match(server, /event\.kind === "queue-worker"/, "worker 长文本不能无订阅地灌进全局 SSE");
assert.match(policy, /create_work_queue/, "执行端和监督端必须知道同构记录应进入队列");
console.log("✅ 队列 UI：创建、进度、并发、暂停、重试、放行和重启恢复入口齐全");
