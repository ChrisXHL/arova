import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { envWithLocalPath, findPi } from "./local-env.ts";

/**
 * 用 --ignore-scripts 装 node-pty 时，其 postinstall 被跳过，prebuild 的 spawn-helper
 * 没有可执行位 → posix_spawnp failed。运行时幂等补上 +x。
 */
function ensureSpawnHelperExec(): void {
	if (process.platform === "win32") return;
	try {
		const req = createRequire(import.meta.url);
		const root = dirname(dirname(req.resolve("node-pty"))); // .../node-pty/lib/index.js -> .../node-pty
		const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
		if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
	} catch {
		/* 不同安装布局或已可执行：忽略 */
	}
}

/**
 * 在伪终端里跑【真实交互式 pi】——执行端保持 100% 原生 TUI 交互。
 * 用一个专属空 session-dir，监督端只需 tail 这个目录里出现的 jsonl 即可旁观，
 * 完全不介入用户 ↔ pi 的交互。
 */
export interface PtyExec {
	pty: pty.IPty;
	sessionDir: string;
	/** 会话 id（目录名）。历史条目记它，之后点历史能把当时的聊天记录调出来。 */
	sessionId: string;
}

export function spawnPiPty(opts: {
	cwd: string;
	cols?: number;
	rows?: number;
	provider?: string;
	/** 追加到执行端系统提示（质量纪律——运动员也要带尺子，不能只武装裁判）。 */
	appendSystemPrompt?: string;
	/** 续接旧会话：传历史条目的 session id，pi 会带着当时的完整上下文继续聊。 */
	resumeSessionId?: string;
	extraArgs?: string[];
}): PtyExec {
	ensureSpawnHelperExec();
	// 会话落在项目里（不是系统临时目录）——重启不丢，历史才能"点开还在、接着聊"
	const sessionId = opts.resumeSessionId || new Date().toISOString().replace(/[:.]/g, "-");
	const sessionDir = join(opts.cwd, ".goal-mode-pi", "sessions", sessionId);
	mkdirSync(sessionDir, { recursive: true });
	// --offline 只关"启动期网络操作"（更新检查横幅），不影响运行时联网工具；让终端一开局更干净
	const args = ["--session-dir", sessionDir, "--offline"];
	if (opts.resumeSessionId) args.push("--continue"); // 续接该目录里最近的会话
	if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
	// 思维链插件：复杂产出前先画图是必然过程（工具层强制），两个执行端入口都自动带上
	const thinkingExt = join(dirname(fileURLToPath(import.meta.url)), "thinking-chain-extension.ts");
	if (existsSync(thinkingExt)) args.push("--extension", thinkingExt);
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.extraArgs) args.push(...opts.extraArgs);

	const proc = pty.spawn(findPi(), args, {
		name: "xterm-256color",
		cols: opts.cols ?? 100,
		rows: opts.rows ?? 30,
		cwd: opts.cwd,
		env: envWithLocalPath(), // .app 启动时 PATH 精简，还原后 pi 才能找到它的依赖
	});
	return { pty: proc, sessionDir, sessionId };
}
