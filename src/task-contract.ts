import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ReferencedSkill = { name: string; instructions: string };
export type TaskContract = {
	schemaVersion: 2;
	taskId: string;
	version: number;
	primaryGoal: string;
	latestRequest: string;
	requirements: string[];
	referencedSkills: ReferencedSkill[];
	updatedAt: string;
};

export type CaptureTaskContractOptions = {
	source?: "user" | "supervisor";
	forceNewTask?: boolean;
	forceRevision?: boolean;
	resolveSkillInstructions?: (name: string) => string | undefined;
};

const EMPTY: TaskContract = {
	schemaVersion: 2,
	taskId: "",
	version: 0,
	primaryGoal: "",
	latestRequest: "",
	requirements: [],
	referencedSkills: [],
	updatedAt: "",
};

export const normalizeUserTaskText = (raw: string) => raw
	.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>\s*/gi, "")
	// Pi 会先发出 `/skill:name 用户要求`，随后再发一次展开后的 skill 正文 + 用户要求。
	// 命令前缀不是目标内容，去掉后两次输入才能精确去重。
	.replace(/^\s*\/skill:[\w.-]+\s*/i, "")
	.replace(/^\s*(?:【新任务】|新任务\s*[:：]|换个任务\s*[:：]?|另外(?:一个|一件)(?:任务|事)\s*[:：]?)\s*/i, "")
	.trim();

export function isSupervisorDirective(raw: string): boolean {
	return /^\s*【(?:监督|系统限流恢复)/.test(normalizeUserTaskText(raw));
}

/** 只有明确的切换措辞才开新任务；普通补充默认继续强化当前目标。 */
export function isExplicitNewTask(raw: string): boolean {
	const text = raw
		.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>\s*/gi, "")
		.replace(/^\s*\/skill:[\w.-]+\s*/i, "")
		.trim();
	return /^(?:【新任务】|新任务\s*[:：]|换个任务\s*[:：]?|另外(?:一个|一件)(?:任务|事)\s*[:：]?)/i.test(text);
}

/** “继续”是控制动作，不应挤掉真正的要求，也不应制造一个新合同版本。 */
export function isContinuationOnly(raw: string): boolean {
	return /^(?:好(?:的)?[，,\s]*)?(?:继续|接着(?:做|来)?|往下做|继续完成|go\s+on)[。！!…\s]*$/i.test(normalizeUserTaskText(raw));
}

/** 只询问既有工作的状态/结果，不构成新要求，也不能让旧计划全部失效。 */
export function isStatusOnlyFollowup(raw: string): boolean {
	const text = normalizeUserTaskText(raw).replace(/[\s。！!?？]+$/g, "");
	return /^(?:现在|当前)?(?:通过接口)?(?:已经)?(?:写入|更新|部署|运行|处理|执行|验证|检查|任务|这件事).{0,16}(?:成功|完成|结束|做好|处理好).{0,5}(?:了吗|没有|没|吗|[?？])$/i.test(text)
		|| /(?:当前)?(?:进度|状态).{0,12}(?:如何|怎样|怎么样|到哪|多少|吗|[?？])$/i.test(text);
}

function isFollowupRevision(raw: string): boolean {
	const text = normalizeUserTaskText(raw);
	return /^(?:还要|还有|再(?:把|加|补|改|删|调整)|另外补充|补充|继续|接着|然后|顺便|不要|别|只要|改成|换成|增加|新增|删除|去掉|把)/.test(text)
		|| /(?:刚才|上面|前面|上一版|这个结果|这份|其中)/.test(text)
		|| /(?:改一下|换一下|删掉|加上|补上|调整一下)[。！!…\s]*$/.test(text);
}

function isStandaloneAction(raw: string): boolean {
	const text = normalizeUserTaskText(raw);
	if (text.length < 6) return false;
	return /(?:检索|搜索|查询|验证|核对|检查|分析|测试|实现|开发|修复|优化|生成|制作|撰写|写一|入库|更新|部署|整理|处理|调查|研究)/.test(text);
}

/**
 * 判断一条真实用户输入是否应开启独立任务代际。
 * 核心规则：上一轮已交付后出现“独立动作句”就是新任务；纠正、补充、继续和状态询问仍留在原任务。
 * progress 只是旧版本兼容兜底，不能再把是否成功 mark_complete 当作唯一边界。
 */
export function shouldStartNewTask(
	contract: TaskContract,
	raw: string,
	context: { completed?: boolean; previousTurnSettled?: boolean; progress?: number } = {},
): boolean {
	if (!contract.primaryGoal) return true;
	if (isExplicitNewTask(raw)) return true;
	if (isContinuationOnly(raw) || isStatusOnlyFollowup(raw) || isFollowupRevision(raw)) return false;
	const text = normalizeUserTaskText(raw);
	// Pi 的 /skill 展开会让同一输入经过 extension 两次；完全相同的目标绝不能二次换代。
	if (text === contract.primaryGoal) return false;
	if (/(?:另一个|另一项|全新|独立的新|换个)(?:任务|问题|目标|数据源|项目)?/.test(text)) return true;
	if (!isStandaloneAction(text)) return false;
	return context.completed === true || context.previousTurnSettled === true || Number(context.progress ?? 0) >= 60;
}

/**
 * 升级自愈：旧版本曾把“上一任务结束后的独立动作”追加进旧合同。
 * 启动时只修复高进度/已交付且语义明确的记录；若原始输入带 /skill，连同该 skill 一起迁到新任务。
 */
export function repairLegacyTaskBoundary(
	workdir: string,
	scopeId?: string,
	context: { completed?: boolean; previousTurnSettled?: boolean; progress?: number } = {},
): TaskContract {
	const contract = loadTaskContract(workdir, scopeId);
	const latest = contract.latestRequest;
	if (!latest || latest === contract.primaryGoal || !contract.requirements.includes(latest)) return contract;
	if (!shouldStartNewTask(contract, latest, context)) return contract;

	let citedSkillNames: string[] = [];
	try {
		const raw = JSON.parse(readFileSync(contractFile(workdir, scopeId), "utf8")) as { requirements?: unknown[] };
		citedSkillNames = (raw.requirements ?? [])
			.filter((item): item is string => typeof item === "string" && normalizeUserTaskText(item) === latest)
			.map((item) => /^\s*\/skill:([\w.-]+)/i.exec(item)?.[1] ?? "")
			.filter(Boolean);
	} catch { /* 损坏文件由 loadTaskContract 的兼容逻辑处理 */ }
	const cited = new Set(citedSkillNames);
	const skillEnvelope = contract.referencedSkills
		.filter((skill) => cited.has(skill.name))
		.map((skill) => `<skill name="${skill.name.replace(/["<>]/g, "")}">${skill.instructions}</skill>`)
		.join("\n");
	return captureTaskContract(workdir, `${skillEnvelope}${skillEnvelope ? "\n\n" : ""}${latest}`, scopeId, {
		source: "user",
		forceNewTask: true,
	});
}

function contractFile(workdir: string, scopeId?: string): string {
	return scopeId
		? join(workdir, ".goal-mode-pi", "runs", scopeId, "task-contract.json")
		: join(workdir, ".goal-mode-pi", "task-contract.json");
}

export function referencedSkills(raw: string, resolveInstructions?: (name: string) => string | undefined): ReferencedSkill[] {
	const found = new Map<string, ReferencedSkill>();
	// Pi 不保证会再把 /skill 命令展开成 <skill> 输入事件，
	// 所以命令本身就必须能把引用记入持久合同。
	const commandName = /^\s*\/skill:([\w.-]+)/i.exec(raw)?.[1]?.trim();
	if (commandName) found.set(commandName, { name: commandName, instructions: resolveInstructions?.(commandName)?.trim() ?? "" });
	const re = /<skill\b([^>]*)>([\s\S]*?)<\/skill>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(raw))) {
		const name = /\bname=["']([^"']+)["']/i.exec(match[1])?.[1]?.trim() || "未命名 skill";
		const instructions = match[2].trim();
		if (instructions || name) found.set(name, { name, instructions });
	}
	return [...found.values()];
}

function normalize(saved: Partial<TaskContract>, scopeId?: string): TaskContract {
	const requirements = Array.isArray(saved.requirements)
		? [...new Set(saved.requirements
			.filter((item): item is string => typeof item === "string")
			.map(normalizeUserTaskText)
			.filter(Boolean))]
		: [];
	const referenced = Array.isArray(saved.referencedSkills)
		? saved.referencedSkills.filter((item): item is ReferencedSkill => !!item && typeof item.name === "string" && typeof item.instructions === "string")
		: [];
	const primaryGoal = typeof saved.primaryGoal === "string" ? normalizeUserTaskText(saved.primaryGoal) : "";
	return {
		...EMPTY,
		...saved,
		schemaVersion: 2,
		taskId: typeof saved.taskId === "string" && saved.taskId ? saved.taskId : primaryGoal ? `task-${scopeId || "legacy"}` : "",
		version: Number.isFinite(saved.version) && Number(saved.version) > 0 ? Math.floor(Number(saved.version)) : primaryGoal ? 1 : 0,
		primaryGoal,
		latestRequest: typeof saved.latestRequest === "string" ? normalizeUserTaskText(saved.latestRequest) : "",
		requirements,
		referencedSkills: referenced,
		updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : "",
	};
}

export function loadTaskContract(workdir: string, scopeId?: string): TaskContract {
	try {
		return normalize(JSON.parse(readFileSync(contractFile(workdir, scopeId), "utf8")) as Partial<TaskContract>, scopeId);
	} catch {
		return { ...EMPTY };
	}
}

/**
 * 记录真正的用户契约。监督自动回灌有独立来源，绝不能伪装成用户要求。
 * 合同完整落盘，不再按“最近 N 条”静默丢弃早期目标或 Skill。
 */
export function captureTaskContract(
	workdir: string,
	raw: string,
	scopeId?: string,
	options: CaptureTaskContractOptions = {},
): TaskContract {
	const old = loadTaskContract(workdir, scopeId);
	const source = options.source ?? (isSupervisorDirective(raw) ? "supervisor" : "user");
	if (source === "supervisor") return old;

	const explicitNewTask = options.forceNewTask || isExplicitNewTask(raw);
	const base = explicitNewTask ? { ...EMPTY } : old;
	const userText = normalizeUserTaskText(raw);
	const nextSkills = referencedSkills(raw, options.resolveSkillInstructions);
	const byName = new Map(base.referencedSkills.map((skill) => [skill.name, skill]));
	let skillsChanged = false;
	for (const skill of nextSkills) {
		const previous = byName.get(skill.name);
		// 新任务重新点名同一 skill 时，可继承上一任务已加载的完整规则。
		// 新的 <skill> 正文若存在，仍以新正文为准。
		const inherited = old.referencedSkills.find((item) => item.name === skill.name);
		const resolved = !skill.instructions && inherited?.instructions ? inherited : skill;
		if (!previous || previous.instructions !== resolved.instructions) skillsChanged = true;
		byName.set(skill.name, resolved);
	}

	const continuationOnly = !!base.primaryGoal && isContinuationOnly(userText);
	const statusOnly = !!base.primaryGoal && isStatusOnlyFollowup(userText);
	const requirementChanged = !!userText && !continuationOnly && !statusOnly && !base.requirements.includes(userText);
	const taskId = base.taskId || `task-${randomUUID()}`;
	const revisionChanged = requirementChanged || skillsChanged || (options.forceRevision === true && base.latestRequest !== userText);
	const contract: TaskContract = {
		schemaVersion: 2,
		taskId,
		version: base.version > 0 ? base.version + (revisionChanged ? 1 : 0) : 1,
		primaryGoal: base.primaryGoal || userText,
		latestRequest: userText || base.latestRequest,
		requirements: requirementChanged ? [...base.requirements, userText] : base.requirements,
		referencedSkills: [...byName.values()],
		updatedAt: new Date().toISOString(),
	};
	const file = contractFile(workdir, scopeId);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(contract, null, 2));
	return contract;
}

/** 给模型的合同事实源。要求与 Skill 全量保留；同构记录应进入 Queue，不应堆进这里。 */
export function taskContractBrief(contract: TaskContract): string {
	const requirements = contract.requirements.map((item, index) => `${index + 1}. ${item}`).join("\n") || "- （尚未记录）";
	const skills = contract.referencedSkills.map((skill) =>
		`- ${skill.name}${skill.instructions ? `：${skill.instructions}` : ""}`,
	).join("\n") || "- （无）";
	return `【不可遗忘的任务契约｜task=${contract.taskId || "未建立"}｜v${contract.version}】\n主目标：${contract.primaryGoal || "（尚未记录）"}\n最近补充：${contract.latestRequest || "（无）"}\n用户要求（完整保留）：\n${requirements}\n用户引用的 skill 与规则（完整保留）：\n${skills}\n后续不得因压缩、换轮或简短追问而丢弃这些约束；普通补充属于同一任务，只有用户明确说“新任务/换个任务”才切换 taskId。`;
}

/**
 * 给分类器/规划器使用的任务全文。首条要求通常同时也是 primaryGoal，必须精确去重，
 * 否则“完整/同时/以及”等信号会被重复计数，把普通任务误判成大任务。
 */
export function taskContractText(contract: TaskContract, fallbackGoal = ""): string {
	const parts = [contract.primaryGoal || fallbackGoal, ...contract.requirements]
		.map((item) => item.trim())
		.filter(Boolean);
	return [...new Set(parts)].join("\n");
}
