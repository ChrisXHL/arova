import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentQueue, queueContractFromTask } from "../src/queue-builder.ts";

const task = {
  primaryGoal: "逐条核对接口里的全部产品记录",
  latestRequest: "写回后必须重新读取验证",
  requirements: ["不得猜测", "写回后必须重新读取验证"],
  referencedSkills: [{ name: "workflow-skill", instructions: "按证据逐字段核对" }],
  updatedAt: new Date().toISOString(),
};
const spec = {
  title: "产品核对队列",
  itemPromptTemplate: "只核对 {{source_key}} 当前记录并给出逐字段证据，完成后按结构返回。",
  items: [
    { sourceKey: "robot-a", payload: { id: "robot-a", fields: { name: "A" } } },
    { sourceKey: "robot-b", payload: { id: "robot-b", fields: { name: "B" } } },
  ],
  parallelEnabled: true,
  concurrency: 4,
  requireEvidence: true,
  requireReadAfterWrite: true,
};

const contract = queueContractFromTask(task, spec);
assert.equal(contract.primaryGoal, task.primaryGoal);
assert.deepEqual(contract.skills.map((skill) => skill.name), ["workflow-skill"]);
assert.deepEqual(contract.deterministicChecks.map((check) => check.type), ["require-no-unresolved", "require-evidence", "require-read-after-write"]);

const cwd = mkdtempSync(join(tmpdir(), "gm-queue-builder-"));
const store = createAgentQueue(cwd, task, spec);
const snapshot = store.getSnapshot();
assert.equal(snapshot.items.length, 2);
assert.equal(snapshot.configuredConcurrency, 4);
assert.equal(store.getContract().skills[0].instructions, "按证据逐字段核对");
assert.equal(JSON.parse(readFileSync(join(store.dir, snapshot.items[0].inputRef), "utf8")).id, "robot-a");
assert.throws(() => queueContractFromTask(task, { ...spec, items: [...spec.items, spec.items[0]] }), /sourceKey 重复/);
rmSync(cwd, { recursive: true, force: true });
console.log("✅ 队列构建：主目标、用户约束、skill、输入隔离和验证规则均已冻结");
