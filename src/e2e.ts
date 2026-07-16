/**
 * 真实端到端：throwaway git 仓库里起真实 pi(PTY) → 程序化"打"进一条任务 →
 * pi 真干活写 session → SessionWatch 只读 tail → Supervisor(真 pi agent) 真核查。
 * 不 mock 任何一端。会用 token。
 *   node --experimental-strip-types src/e2e.ts <workdir>
 */
import { spawnPiPty } from "./pty-exec.ts";
import { SessionWatch } from "./session-watch.ts";
import { Supervisor } from "./supervisor.ts";
import type { UIEvent } from "./ui-events.ts";

const workdir = process.argv[2] || process.cwd();
const provider = process.env.PI_PROVIDER || "anthropic";
const task = "创建 hello.txt，内容恰好是 hello world";
const testCmd = "test -f hello.txt && grep -q 'hello world' hello.txt && echo PASS";

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const exec = spawnPiPty({ cwd: workdir, provider, extraArgs: ["-a"] });
log("pi PTY 起，sessionDir =", exec.sessionDir);

let booted = false;
let lastOut = Date.now();
exec.pty.onData(() => {
	lastOut = Date.now();
});

const watch = new SessionWatch(exec.sessionDir);
const supervisor = new Supervisor({ workdir, testCmd, provider });
supervisor.on("ui", (e: UIEvent) => {
	if (e.kind === "supervisor" && e.sub === "tool") log("监督·工具调用:", e.text);
	else if (e.kind === "supervisor" && e.sub === "tool-result") log("监督·拿到事实:", e.text);
	else if (e.kind === "supervisor" && e.sub === "suggest") log("监督·建议:", e.text);
	else if (e.kind === "supervisor" && e.sub === "turn") log("监督·", e.text);
	else if (e.kind === "state") log("  state: 进度", `${e.state.progress}%`, "测试门", e.state.lastTestPassed);
	else if (e.kind === "objective") {
		log(`🎯 OBJECTIVE ${e.status} 进度 ${e.state.progress}% 测试门 ${e.state.lastTestPassed}`);
		finish(e.status === "reached" && e.state.lastTestPassed ? 0 : 2);
	}
});
watch.on("user-task", (t) => log("watch→ user-task:", t));
watch.on("turn-end", (t) => {
	log("watch→ turn-end (执行端一轮结束)，assistant尾巴:", JSON.stringify(t.slice(-80)));
});
watch.on("turn-cancelled", (reason) => log("watch→ turn-cancelled:", reason));

let sentTask = false;
async function main() {
	await supervisor.start();
	watch.on("user-task", (t) => supervisor.onUserTask(t));
	watch.on("turn-end", (t) => {
		supervisor.noteExecutorTurnSettled();
		void supervisor.review(t);
	});
	watch.on("turn-cancelled", (reason) => supervisor.cancelCurrent(reason));
	watch.start();

	// 等 pi 真正就绪（启动 ≥6s 且输出已静默 ≥2s），再分两步把任务"打"进真实终端
	const start = Date.now();
	const boot = setInterval(() => {
		if (booted) return;
		if (Date.now() - start > 6000 && Date.now() - lastOut > 2000) {
			booted = true;
			clearInterval(boot);
			log("pi 已就绪，输入任务文本:", task);
			exec.pty.write(task);
			setTimeout(() => {
				log("发回车提交");
				exec.pty.write("\r");
				sentTask = true;
			}, 500);
		}
	}, 500);
}

function finish(code: number) {
	log("结束，退出码", code);
	try {
		watch.stop();
		supervisor.stop();
		exec.pty.kill();
	} catch {
		/* ignore */
	}
	setTimeout(() => process.exit(code), 500);
}

// 总超时
setTimeout(() => {
	log("⏰ 总超时（180s），未达成。sentTask =", sentTask);
	finish(3);
}, 180_000);

void main();
