import { Orchestrator, type UIEvent } from "./orchestrator.ts";

/** 薄 CLI 包装：把 Orchestrator 的 UIEvent 打到终端。GUI 用 server.ts / Electron。 */
async function main() {
	const goal = process.argv.slice(2).join(" ") || process.env.GOAL || "";
	if (!goal) {
		console.error("用法: node src/main.ts <目标>   （WORKDIR / TEST_CMD / PI_PROVIDER / MAX_CYCLES 环境变量）");
		process.exit(1);
	}

	const orch = new Orchestrator({
		goal,
		workdir: process.env.WORKDIR || process.cwd(),
		testCmd: process.env.TEST_CMD || "npm test",
		provider: process.env.PI_PROVIDER,
		maxCycles: Number(process.env.MAX_CYCLES ?? 0),
	});

	orch.on("ui", (e: UIEvent) => {
		if (e.kind === "executor" && e.sub === "text") process.stdout.write(e.text ?? "");
		else if (e.kind === "executor" && e.sub === "tool") console.log(`\n[executor 工具] ${e.text}`);
		else if (e.kind === "supervisor" && e.sub === "turn") console.log(`\n🔍 ${e.text}`);
		else if (e.kind === "supervisor" && e.sub === "tool") console.log(`  [监督工具] ${e.text}`);
		else if (e.kind === "state") console.log(`  进度=${e.state.progress}% 测试门=${e.state.lastTestPassed}`);
		else if (e.kind === "log") console.log(`[${e.level}] ${e.text}`);
		else if (e.kind === "objective") {
			// CLI 是一次性的：目标达成/暂停即退出（GUI 才持续结对、可继续下达）
			console.log(`\n${e.status === "reached" ? "🎉 目标达成" : `⏹ ${e.reason || "监督已暂停"}`}，进度 ${e.state.progress}%`);
			void orch.stop().then(() => process.exit(0));
		} else if (e.kind === "done") {
			console.log(`\n⏹ 停止(${e.reason})，进度 ${e.state.progress}%`);
			process.exit(0);
		}
	});

	process.on("SIGINT", () => void orch.stop());
	await orch.start();
}

void main();
