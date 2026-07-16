/**
 * 冒烟测试：验证核心接缝 —— 我的 rpc-process ↔ `pi --mode rpc` 二进制。
 * 不跑监督 SDK、不改任何文件。只证明：能驱动 executor、能收到结构化事件流、能取结果。
 *   运行: PI_PROVIDER=anthropic node --experimental-strip-types src/smoke.ts
 */
import { createRpcProcess } from "./rpc-process.ts";

const provider = process.env.PI_PROVIDER ?? "anthropic";
const cwd = process.env.WORKDIR ?? process.cwd();

const exec = createRpcProcess({ cwd, args: ["--provider", provider] });

const eventTypes = new Map<string, number>();
exec.onEvent((e) => {
	const t = (e as { type?: string }).type ?? "unknown";
	eventTypes.set(t, (eventTypes.get(t) ?? 0) + 1);
});
exec.onExit((err) => console.log("[exit]", err?.message ?? "clean"));

async function run() {
	console.log("→ get_state");
	const state = await exec.send({ type: "get_state" });
	console.log("← get_state ok:", JSON.stringify(state).slice(0, 200));

	console.log('→ prompt: "用一个词回答：1+1=?"');
	await exec.send({ type: "prompt", message: "用一个词回答：1+1=? 只输出答案。" });

	await new Promise((r) => setTimeout(r, 12000)); // 等它一轮

	console.log("→ get_last_assistant_text （这就是「提取执行结果」）");
	const last = await exec.send({ type: "get_last_assistant_text" });
	console.log("← executor 的结构化输出:", JSON.stringify(last).slice(0, 400));

	console.log("\n事件流统计:", Object.fromEntries(eventTypes));
	await exec.dispose();
	process.exit(0);
}

run().catch(async (e) => {
	console.error("smoke 失败:", e);
	await exec.dispose();
	process.exit(1);
});
