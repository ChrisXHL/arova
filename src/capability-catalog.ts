/**
 * 把已实际加载的能力压成一段可供监督决策使用的目录。
 * 完整 skill 清单仍由 Pi 放进系统提示；这里强调那些会改变“该怎么做”判断的能力，
 * 避免监督只因没想起来而错过 workflow 或 computer use。
 */
export function capabilityDecisionBrief(skillNames: readonly string[], toolNames: readonly string[]): string {
	const skills = [...new Set(skillNames)].sort();
	const tools = [...new Set(toolNames)].sort();
	const matchingSkills = (pattern: RegExp) => skills.filter((name) => pattern.test(name));
	const matchingTools = (pattern: RegExp) => tools.filter((name) => pattern.test(name));
	const workflowSkills = matchingSkills(/workflow|subagent|orchestrat/i);
	const browserSkills = matchingSkills(/browser|web|search|computer/i);
	const computerTools = matchingTools(/ui|browser|navigate|evaluate|computer/i);

	return [
		"【当前已加载能力目录——决策前必须纳入方案比较】",
		`可调用 skill：${skills.length} 个。`,
		`全部 skill 名称：${skills.join("、") || "（无）"}`,
		workflowSkills.length ? `工作流/多 agent：${workflowSkills.join("、")}` : "工作流/多 agent：当前未发现专项 skill。",
		browserSkills.length ? `浏览与检索相关 skill：${browserSkills.join("、")}` : "浏览与检索相关 skill：当前未发现专项 skill。",
		computerTools.length ? `computer use 实际工具：${computerTools.join("、")}` : "computer use：当前没有已激活的 UI 操作工具。",
		computerTools.length
			? "检索 API/skill 被限流、反爬、登录墙或结果不足时：停止重复同一路径，优先用这些 computer use 工具的默认浏览器检索公开信息；不得绕过访问控制。"
			: "检索 API/skill 受限且当前没有 computer use 工具时：换公开来源或明确验证缺口，不要无意义重试。",
		"在建议执行路径、否定某个方案或要求人工操作前，先判断现有 skill/工具能否以更低成本完成或验证；能力存在不等于必须使用，涉及登录、付费、发布或不可逆外部动作仍需按风险处理。",
	].join("\n");
}
