import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createSharedCompactionCheckpoint, markCompactionParticipant, pendingSharedCompaction } =
  await import(join(root, "src/context-coordination.ts"));
const work = mkdtempSync(join(tmpdir(), "gm-context-"));
mkdirSync(join(work, ".goal-mode-pi", "thinking"), { recursive: true });
writeFileSync(join(work, ".goal-mode-pi", "state.json"), JSON.stringify({
  goal: "修复压缩联动", trueIntent: "双方不能失去共同目标",
  reasoningAudit: { userValueFunction: "稳定优先" },
  focusContract: { point: "共享一个检查点" }, progress: 60, findings: ["已定位竞态"],
}));
writeFileSync(join(work, ".goal-mode-pi", "thinking", "latest.json"), JSON.stringify({ focus: { point: "执行端当前点" } }));

const checkpoint = createSharedCompactionCheckpoint(work, "executor");
markCompactionParticipant(work, "executor", "waiting", checkpoint);
markCompactionParticipant(work, "supervisor", "requested", checkpoint);
const received = pendingSharedCompaction(work, "supervisor");
if (received?.version !== checkpoint.version || received.trueIntent !== "双方不能失去共同目标") throw new Error("监督端没有收到同版本检查点");
markCompactionParticipant(work, "supervisor", "compacted", checkpoint);
if (pendingSharedCompaction(work, "supervisor")) throw new Error("已完成请求不应重复消费");
console.log("✅ 上下文联动协议：共享检查点、请求消费与状态合并通过");
