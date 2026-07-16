import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadTaskLedger, saveTaskLedger, taskCompletionProblem } = await import(join(root, "src/task-ledger.ts"));
const { createSupervisorExtension } = await import(join(root, "src/supervisor-extension.ts"));
const { loadState } = await import(join(root, "src/state.ts"));
const executorExtension = (await import(join(root, "src/thinking-chain-extension.ts"))).default;
const work = mkdtempSync(join(tmpdir(), "gm-task-ledger-"));
let ok = 0, bad = 0;
const t = (name, pass) => pass ? ok++ : (bad++, console.log("❌", name));

const state = loadState({ taskId: "t1", contractVersion: 1, goal: "修复登录失败", workdir: work, testCmd: "" });
const tools = new Map(); createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });
const text = (r) => r.content[0].text;
t("通用账本工具齐全", ["set_task_ledger", "record_task_fact", "record_task_hypothesis", "record_task_gap", "record_task_attempt", "verify_task_requirement", "inspect_task_ledger"].every((name) => tools.has(name)));
t("建立可验证要求", text(await tools.get("set_task_ledger").execute("1", { requirements: [{ id: "login", description: "登录请求成功且错误不再复现" }], next_action: "读取错误日志" })).includes("已建立"));
t("失败不能原地重试", text(await tools.get("record_task_attempt").execute("2", { action: "调用登录接口", outcome: "failed", blocker: "tool_failure", learned: "接口返回超时，当前调用没有新增信息", next_action: "重试" })).startsWith("拒绝"));
t("失败必须切换路径", text(await tools.get("record_task_attempt").execute("3", { action: "调用登录接口", outcome: "failed", blocker: "tool_failure", learned: "接口返回超时，当前调用没有新增信息", next_action: "读取服务端错误日志并检查超时配置" })).includes("下一步"));
t("先补齐事实与要求证据", text(await tools.get("record_task_fact").execute("4", { id: "runtime-login", claim: "修复后真实登录请求返回 200", evidence: "集成测试与本地运行日志均记录 HTTP 200", kind: "runtime" })).includes("已记录事实") && text(await tools.get("verify_task_requirement").execute("5", { id: "login", evidence: "集成测试通过且运行日志显示登录接口 HTTP 200，旧超时错误不再出现。" })).includes("完成证据"));
t("未验证假设阻止完成", text(await tools.get("record_task_hypothesis").execute("6", { id: "cause", statement: "超时由数据库连接池耗尽导致", status: "open", evidence: "" })).includes("= open") && taskCompletionProblem(loadTaskLedger(work), "t1", 1).includes("未验证假设"));
t("关键缺口阻止完成", text(await tools.get("record_task_hypothesis").execute("7", { id: "cause", statement: "超时由数据库连接池耗尽导致", status: "rejected", evidence: "连接池指标正常，日志无耗尽事件" })).includes("rejected") && text(await tools.get("record_task_gap").execute("8", { id: "runtime", question: "修复后真实登录是否成功", critical: true, status: "open", resolution: "" })).includes("= open") && taskCompletionProblem(loadTaskLedger(work), "t1", 1).includes("关键缺口"));
t("事实、缺口和要求证据闭合", text(await tools.get("record_task_gap").execute("9", { id: "runtime", question: "修复后真实登录是否成功", critical: true, status: "resolved", resolution: "集成测试与运行日志均返回 HTTP 200" })).includes("resolved") && !taskCompletionProblem(loadTaskLedger(work), "t1", 1));
state.contractVersion = 2;
t("需求调整可保留已验证上下文", text(await tools.get("set_task_ledger").execute("9b", { requirements: [{ id: "login", description: "登录成功且错误不再复现" }, { id: "audit", description: "补充审计日志" }], next_action: "补充审计验证", preserve_verified_context: true })).includes("已建立") && loadTaskLedger(work).contractVersion === 2 && loadTaskLedger(work).facts.some((item) => item.id === "runtime-login") && loadTaskLedger(work).requirements.find((item) => item.id === "login").evidence.length > 0 && loadTaskLedger(work).requirements.find((item) => item.id === "audit").evidence === "");

const executorWork = mkdtempSync(join(tmpdir(), "gm-executor-ledger-"));
const handlers = {}, executorTools = new Map();
executorExtension({ on: (name, handler) => (handlers[name] = handler), registerTool: (tool) => executorTools.set(tool.name, tool), getCommands: () => [] });
handlers.session_start({ cwd: executorWork });
handlers.input({ text: "修复登录失败并验证运行结果" });
t("执行端可写入同一类账本", executorTools.has("set_task_ledger") && text(await executorTools.get("set_task_ledger").execute("10", { requirements: [{ id: "fix", description: "登录成功" }], next_action: "读取日志" })).includes("已建立") && loadTaskLedger(executorWork).requirements[0].id === "fix");

rmSync(work, { recursive: true, force: true });
rmSync(executorWork, { recursive: true, force: true });
console.log(bad ? `❌ ${bad} 项失败` : `✅ 通用任务账本：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
