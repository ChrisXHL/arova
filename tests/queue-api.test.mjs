import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/queue-store.ts";

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
const waitForServer = async (base, child) => {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error("server 提前退出");
    try { if ((await fetch(`${base}/defaults`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待 queue API 启动超时");
};

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "gm-queue-api-work-"));
const home = mkdtempSync(join(tmpdir(), "gm-queue-api-home-"));
const contract = {
  primaryGoal: "逐条核对",
  requirements: ["隔离"], skills: [], inputSchema: { type: "object" }, outputSchema: { type: "object" },
  itemPromptTemplate: "处理当前 {{source_key}} 并返回可靠结果",
  deterministicChecks: [{ id: "u", type: "require-no-unresolved" }],
  semanticReviewPolicy: "never", maxSemanticRedos: 0, maxTransientRetries: 1,
};

// 模拟上次应用在 Item 运行时崩溃。首次读取该项目时应懒恢复，而不是冷启动扫描所有项目。
const interrupted = QueueStore.create(work, contract, [{ sourceKey: "stale", payload: { id: "stale" } }], { queueId: "interrupted" });
await interrupted.patchQueue({ state: "running" });
const stale = await interrupted.claimNext("old-worker", 600_000);
await interrupted.patchItem(stale.id, { status: "running" });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["--experimental-strip-types", "src/server.ts"], {
  cwd: root,
  env: { ...process.env, HOME: home, PORT: String(port), WORKDIR: work },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
try {
  await waitForServer(base, child);
  let listed = await (await fetch(`${base}/queues?cwd=${encodeURIComponent(work)}`)).json();
  assert.equal(listed.queues[0].state, "paused");
  assert.equal(new QueueStore(work, "interrupted").getSnapshot().items[0].status, "retry_wait");

  const createdResponse = await fetch(`${base}/queues`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: work, title: "API smoke", contract, items: [{ sourceKey: "a", payload: { id: "a" } }, { sourceKey: "b", payload: { id: "b" } }], parallelEnabled: true, concurrency: 3 }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const id = created.snapshot.id;
  listed = await (await fetch(`${base}/queues?cwd=${encodeURIComponent(work)}`)).json();
  assert.equal(listed.queues.find((queue) => queue.id === id).stats.total, 2);

  const detail = await (await fetch(`${base}/queues/${id}?cwd=${encodeURIComponent(work)}&limit=1`)).json();
  assert.equal(detail.snapshot.items.length, 1);
  assert.equal(detail.page.filteredTotal, 2);

  const parallel = await fetch(`${base}/queues/${id}/parallel?cwd=${encodeURIComponent(work)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal((await parallel.json()).snapshot.configuredConcurrency, 1);
  const cancelled = await fetch(`${base}/queues/${id}/cancel?cwd=${encodeURIComponent(work)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal((await cancelled.json()).snapshot.state, "cancelled");
} finally {
  if (child.exitCode == null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
assert.equal(stderr.trim(), "", stderr);
console.log("✅ Queue API：懒恢复、创建、列表、分页、并发切换和取消通过");
