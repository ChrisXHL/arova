import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ExtensionAPI,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 发现（loop engineering 的第一个动作）：让循环自己找活，而不是人逐条喂。
 * 分诊模式：确定性先集结信号 → 一个发现 agent 判断哪些值得做、变成具体目标。
 */

const DISCOVER_POLICY = `你是 goal-mode 的"发现"agent（晨间分诊）。下面给你一批项目信号。
你的活：判断哪些【真正值得本轮做】，把它们变成【具体、可执行、单一】的目标，每个调一次 propose_goal 提出。
规则：
- 只提真正可行动的；跳过噪音、模糊的、以及已在 backlog 里的。
- 优先阻断性问题（测试挂、编译/类型错）。
- 必要时用 read/grep/bash 看一眼代码再判断。
- 没有值得做的就别硬提，宁缺毋滥。`;

function sh(cmd: string, cwd: string, timeoutMs = 60_000): string {
	try {
		return execFileSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string };
		return (err.stdout ?? "") + (err.stderr ?? "");
	}
}

function detectTestCmd(dir: string): string {
	const has = (f: string) => existsSync(join(dir, f));
	if (has("package.json")) return "npm test";
	if (has("pyproject.toml") || has("pytest.ini") || has("tests") || has("setup.py")) return "pytest -q";
	if (has("Cargo.toml")) return "cargo test";
	if (has("go.mod")) return "go test ./...";
	return "";
}

/** 确定性集结信号：失败测试 / 类型错 / TODO / 未提交改动 / 现有 backlog。 */
export function gatherSignals(workdir: string, backlog: string): string {
	const parts: string[] = [];

	const testCmd = process.env.TEST_CMD || detectTestCmd(workdir);
	if (testCmd) {
		const out = sh(`${testCmd} 2>&1 | tail -40`, workdir, 120_000);
		parts.push(`## 测试 (${testCmd})\n${out.trim() || "(无输出)"}`);
	}
	if (existsSync(join(workdir, "tsconfig.json"))) {
		parts.push(`## 类型检查 (tsc --noEmit)\n${sh("npx tsc --noEmit 2>&1 | head -30", workdir, 120_000).trim() || "(无错误)"}`);
	}
	const todos = sh(
		`git grep -nE 'TODO|FIXME' 2>/dev/null | head -25 || grep -rnE 'TODO|FIXME' --include='*.*' . 2>/dev/null | head -25`,
		workdir,
	);
	if (todos.trim()) parts.push(`## TODO/FIXME\n${todos.trim()}`);
	const status = sh("git status --porcelain 2>/dev/null | head -30", workdir);
	if (status.trim()) parts.push(`## 未提交改动\n${status.trim()}`);
	parts.push(`## 现有 backlog（别重复提）\n${backlog.trim() || "(空)"}`);

	return parts.join("\n\n");
}

/** 发现 agent：读信号 → 判断 → 用 propose_goal 提出具体目标。返回目标列表。 */
export async function discoverGoals(workdir: string, provider?: string): Promise<string[]> {
	let backlog = "";
	try {
		backlog = readFileSync(join(workdir, ".goal-mode-pi", "backlog.md"), "utf8");
	} catch {
		/* 没有 backlog */
	}
	const signals = gatherSignals(workdir, backlog);

	const goals: string[] = [];
	const ext = (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "propose_goal",
			label: "Propose Goal",
			description: "提出一个具体、可执行、值得本轮做的目标。每个值得做的问题调一次。",
			parameters: Type.Object({ goal: Type.String(), why: Type.Optional(Type.String()) }),
			execute: async (_id: string, p: { goal: string; why?: string }) => {
				const g = p.goal.trim();
				if (g) goals.push(g);
				return { content: [{ type: "text" as const, text: `已记录目标：${g}` }], details: {} };
			},
		});
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd: workdir,
		agentDir: getAgentDir(),
		appendSystemPromptOverride: (base) => [...base, DISCOVER_POLICY],
		extensionFactories: [ext],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: workdir,
		resourceLoader,
		excludeTools: ["edit", "write"], // 发现阶段只看不改
		sessionManager: SessionManager.inMemory(workdir),
	});
	try {
		await session.prompt(`这是项目当前的信号，请分诊并用 propose_goal 提出值得本轮做的目标：\n\n${signals}`);
	} finally {
		session.dispose();
	}
	return goals;
}
