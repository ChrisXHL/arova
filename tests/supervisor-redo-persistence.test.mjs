import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.ts";

function preparedSupervisor(maxRedos) {
  const work = mkdtempSync(join(tmpdir(), "gm-supervisor-redo-"));
  const supervisor = new Supervisor({ workdir: work, testCmd: "", maxRedos });
  const events = [];
  supervisor.on("ui", (event) => events.push(event));
  supervisor.state.goal = "持续修正直到真正达到验收标准";
  supervisor.active = true;
  supervisor.agent = {
    prompt: async () => { supervisor.directives.push("继续根据最新证据修正当前未达标点"); },
  };
  return { work, supervisor, events };
}

// 默认不再沿用“4 轮强制停止”：第 6 轮仍会继续派发。
{
  const { work, supervisor, events } = preparedSupervisor(0);
  for (let round = 0; round < 6; round++) await supervisor.review(`第 ${round + 1} 轮产出`);
  const drives = events.filter((event) => event.kind === "drive");
  assert.equal(drives.length, 6);
  assert.equal(drives.at(-1).round, 6);
  assert.equal(events.some((event) => event.kind === "objective" && event.status === "halted"), false);
  assert.equal(events.some((event) => event.kind === "log" && /4 轮|停手等你介入/.test(event.text)), false);
  rmSync(work, { recursive: true, force: true });
}

// 用户明确设置预算时仍可暂停，并说明这是用户配置，不冒充任务本身的阻塞。
{
  const { work, supervisor, events } = preparedSupervisor(2);
  for (let round = 0; round < 3; round++) await supervisor.review(`预算测试 ${round + 1}`);
  assert.equal(events.filter((event) => event.kind === "drive").length, 2);
  const halted = events.find((event) => event.kind === "objective" && event.status === "halted");
  assert.match(halted.reason, /配置的自动重做预算/);
  rmSync(work, { recursive: true, force: true });
}

console.log("✅ 监督持续推进：默认超过 4 轮仍继续，仅显式预算可暂停");

const renderer = readFileSync(join(import.meta.dirname, "..", "renderer", "app.js"), "utf8");
assert.match(renderer, /已自动重做\\s\*4\\s\*轮仍未达标，停手等你介入/, "恢复旧会话时不应再显示已废弃的固定 4 轮警告");
