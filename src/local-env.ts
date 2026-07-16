import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Finder 双击启动的 .app 只有精简 PATH，找不到 pi/node。
 * 这里用登录 shell 还原用户真实 PATH，并定位本地 pi —— 让"链接本地 pi"在打包后的应用里也成立。
 */
const COMMON_BIN = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", join(homedir(), ".local/bin")];

let cachedPath: string | undefined;

export function loginPath(): string {
	if (cachedPath) return cachedPath;
	let shellPath = "";
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		shellPath = execFileSync(shell, ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 4000 }).trim();
	} catch {
		/* 登录 shell 不可用：退回常见目录 */
	}
	const parts = new Set<string>();
	for (const p of [shellPath, process.env.PATH ?? ""].join(":").split(":")) if (p) parts.add(p);
	for (const p of COMMON_BIN) if (existsSync(p)) parts.add(p);
	cachedPath = [...parts].join(":");
	return cachedPath;
}

/** 进程 env 叠加还原后的 PATH，喂给子进程（pi / 服务）。 */
export function envWithLocalPath(): { [key: string]: string } {
	const env: { [key: string]: string } = {};
	for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
	env.PATH = loginPath();
	return env;
}

/**
 * 定位 pi：必须优先使用应用锁定的依赖版本。
 * 全局 pi 可能比 SDK 旧；0.79.7 的自动压缩会从 assistant 尾消息错误 continue，
 * 正是 “Cannot continue from message role: assistant” 的残余根因。
 */
export function findPi(): string {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const bundled = join(dirname(entry), "cli.js");
		if (existsSync(bundled)) return bundled;
	} catch {
		/* 开发依赖不完整时再退回用户全局安装 */
	}
	for (const dir of COMMON_BIN) {
		const p = join(dir, "pi");
		if (existsSync(p)) return p;
	}
	try {
		const out = execFileSync("/bin/sh", ["-c", "command -v pi"], {
			encoding: "utf8",
			env: { ...process.env, PATH: loginPath() },
		}).trim();
		if (out) return out;
	} catch {
		/* not found */
	}
	return "pi";
}
