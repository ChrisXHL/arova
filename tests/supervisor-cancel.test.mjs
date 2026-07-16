import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.ts";

const work = mkdtempSync(join(tmpdir(), "gm-supervisor-cancel-"));
const supervisor = new Supervisor({ workdir: work, testCmd: "" });
let aborted = 0;
supervisor.agent = { isStreaming: true, abort: async () => { aborted++; } };
const logs = [];
supervisor.on("ui", (e) => logs.push(e));
supervisor.cancelCurrent("用户按下取消");
await new Promise((resolve) => setTimeout(resolve, 0));
rmSync(work, { recursive: true, force: true });
if (aborted !== 1 || !logs.some((e) => e.kind === "log" && e.text.includes("同步停止"))) throw new Error("监督没有随执行端取消");
console.log("✅ 监督取消联动：正在生成的监督请求被立即 abort");
