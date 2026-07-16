import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/queue-store.ts";
import { QueueWorker } from "../src/queue-worker.ts";
import { validateQueueRunResult } from "../src/queue-validator.ts";

class FakeRpc {
  emitter = new EventEmitter();
  commands = [];
  resultText;
  constructor(resultText) { this.resultText = resultText; }
  async send(command) {
    this.commands.push(command);
    if (command.type === "get_state") return { type: "response", command: "get_state", success: true, data: { sessionId: "rpc-session-1" } };
    if (command.type === "get_last_assistant_text") return { type: "response", command: command.type, success: true, data: { text: this.resultText } };
    if (command.type === "prompt") queueMicrotask(() => {
      this.emitter.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: this.resultText } });
      this.emitter.emit("event", { type: "agent_end" });
    });
    return { type: "response", command: command.type, success: true };
  }
  onEvent(listener) { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
  onExit(listener) { this.emitter.on("exit", listener); return () => this.emitter.off("exit", listener); }
  async dispose() {}
}

const work = mkdtempSync(join(tmpdir(), "gm-queue-worker-"));
const store = QueueStore.create(work, {
  primaryGoal: "逐条验证",
  requirements: ["不允许猜测"],
  skills: [{ name: "workflow", instructions: "每次只处理一条" }],
  inputSchema: { type: "object" },
  outputSchema: { type: "object", required: ["itemId", "contractHash", "skillUsage"] },
  itemPromptTemplate: "只核验 {{source_key}}",
  deterministicChecks: [
    { id: "no-unresolved", type: "require-no-unresolved" },
    { id: "evidence", type: "require-evidence" },
    { id: "readback", type: "require-read-after-write" },
  ],
  semanticReviewPolicy: "when_needed",
  maxSemanticRedos: 2,
  maxTransientRetries: 5,
}, [{ sourceKey: "row-1", payload: { name: "A" } }], { queueId: "queue-worker-test" });
const contract = store.getContract();
const item = store.getSnapshot().items[0];
const result = {
  itemId: item.id,
  attemptId: "attempt-1",
  contractHash: contract.hash,
  inputDigest: item.inputDigest,
  outcome: "changed",
  observations: [{ field: "name", before: "A", conclusion: "需要规范化" }],
  changes: [{ field: "name", before: "A", after: "Alpha", reason: "证据一致" }],
  evidence: [{ field: "name", source: "https://example.com", retrievedAt: "2026-07-15T00:00:00.000Z", evidenceHash: "e1" }],
  unresolved: [],
  writeback: { idempotencyKey: "k", requestResult: "200", beforeDigest: "b", afterDigest: "a", readAfterWritePassed: true },
  skillUsage: contract.skills.map(({ name, sha256 }) => ({ name, sha256 })),
};
const text = `<queue_result>\n${JSON.stringify(result)}\n</queue_result>`;
let fake, processOptions;
const worker = new QueueWorker({
  cwd: work,
  contract,
  item,
  input: store.readItemInput(item.id),
  workerId: "worker-1",
  attemptId: "attempt-1",
  processFactory: (options) => { processOptions = options; return (fake = new FakeRpc(text)); },
});
const ran = await worker.run();
assert.equal(ran.sessionId, "rpc-session-1");
assert.equal(ran.result.itemId, item.id);
assert.ok(fake.commands.some((command) => command.type === "set_auto_compaction" && command.enabled === false));
assert.ok(fake.commands.some((command) => command.type === "set_auto_retry" && command.enabled === false));
assert.ok(fake.commands.find((command) => command.type === "prompt").message.includes("只核验 row-1"));
assert.ok(fake.commands.find((command) => command.type === "prompt").message.includes(item.inputDigest));
assert.equal(processOptions.env.GOAL_MODE_QUEUE_WORKER, "1", "Item worker 必须禁止递归创建子队列");
assert.equal(processOptions.args.includes("--no-extensions"), false, "Item worker 不能丢失正常 Skill/extension 能力");

const report = validateQueueRunResult(ran.result, contract, { itemId: item.id, attemptId: "attempt-1", inputDigest: item.inputDigest });
assert.equal(report.passed, true);
assert.equal(report.needsSemanticReview, true);

const bad = structuredClone(result);
bad.contractHash = "wrong";
bad.writeback.readAfterWritePassed = false;
bad.skillUsage = [];
const rejected = validateQueueRunResult(bad, contract, { itemId: item.id, attemptId: "attempt-1", inputDigest: item.inputDigest });
assert.equal(rejected.passed, false);
assert.ok(rejected.errors.some((error) => error.includes("contractHash")));
assert.ok(rejected.errors.some((error) => error.includes("Skill")));
assert.ok(rejected.errors.some((error) => error.includes("read-after-write")));

rmSync(work, { recursive: true, force: true });
console.log("✅ QueueWorker：独立 RPC prompt、Skill/合同注入、结构化解析和确定性验收通过");
