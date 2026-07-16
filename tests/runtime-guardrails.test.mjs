import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupervisorMemory, sessionMemoryFile } from "../src/supervisor-memory.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = readFileSync(join(root, "src/loop.ts"), "utf8");
const server = readFileSync(join(root, "src/server.ts"), "utf8");
const worker = readFileSync(join(root, "src/queue-worker.ts"), "utf8");
const builder = readFileSync(join(root, "src/queue-builder.ts"), "utf8");
const orchestrator = readFileSync(join(root, "src/orchestrator.ts"), "utf8");

assert.match(loop, /GOAL_TIMEOUT_MS \?\? 0/, "loop 默认不能有隐藏的五分钟截止时间");
assert.match(server, /GOAL_TIMEOUT_MS \?\? 0/, "GUI loop 默认不能有隐藏截止时间");
assert.match(loop, /finish\("paused"\)/, "显式超时或用户停止必须保留为暂停");
assert.match(loop, /if \(status !== "paused"\) markBacklog/, "暂停不能把 backlog 标成阻塞或完成");
assert.ok(loop.indexOf('watch.start();') < loop.indexOf('void sup.start()'), "loop 必须先监听首条用户任务，再等待监督端初始化");
assert.match(worker, /contract\.itemTimeoutMs \?\? 0/, "队列 Item 默认必须不限时");
assert.doesNotMatch(worker, /900_000|15 \* 60/, "不能恢复旧的 15 分钟隐藏超时");
assert.match(builder, /itemTimeoutMs: Math\.max\(0, Math\.floor\(spec\.itemTimeoutMs \?\? 0\)\)/);
assert.doesNotMatch(orchestrator, /"--no-extensions"/, "旧 CLI 也不能关闭 Skill 和 extension");

const work = mkdtempSync(join(tmpdir(), "gm-memory-full-"));
const memoryPath = sessionMemoryFile(work, "thread-a");
mkdirSync(dirname(memoryPath), { recursive: true });
const first = "FIRST_REQUIREMENT_必须始终保留";
const last = "LAST_REQUIREMENT_必须始终保留";
writeFileSync(memoryPath, `${first}\n${"中间记忆".repeat(3000)}\n${last}\n`);
const oldBudget = process.env.GOAL_MODE_MEMORY_MAX_CHARS;
delete process.env.GOAL_MODE_MEMORY_MAX_CHARS;
const loaded = loadSupervisorMemory(work, "thread-a");
if (oldBudget == null) delete process.env.GOAL_MODE_MEMORY_MAX_CHARS;
else process.env.GOAL_MODE_MEMORY_MAX_CHARS = oldBudget;
assert.match(loaded, new RegExp(first));
assert.match(loaded, new RegExp(last));
assert.equal(loaded.includes("因你显式配置"), false, "默认不能静默截断长期记忆");
rmSync(work, { recursive: true, force: true });

console.log("✅ 运行护栏：默认不限时、暂停可恢复、CLI 能力完整且长期记忆默认全量加载");
