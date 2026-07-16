/**
 * 高置信度的内部术语泄漏检查。
 *
 * 它不是“AI 味检测器”：诸如“系统”“流程”“证据”在合适的产品里完全可以成立。
 * 这里只拦截只属于 goal-mode 内部执行机制、几乎不该出现在面向公众文案里的词。
 */
const INTERNAL_TERMS = [
	"任务账本", "目标账本", "任务合同", "单点契约", "认知审计", "需求冻结", "完成门", "验收门", "研究合同",
	"Minimum Viable Model", "focus_step", "think_map", "mark_complete", "set_task_ledger", "goal-mode",
];

const PUBLIC_COPY_FILE = /\.(html?|mdx?|tsx?|jsx?|vue|svelte)$/i;

export function isPublicCopyFile(path: string): boolean {
	return PUBLIC_COPY_FILE.test(path);
}

export function internalTermsInContent(text: string): string[] {
	return INTERNAL_TERMS.filter((term) => text.toLowerCase().includes(term.toLowerCase()));
}

export function contentVoiceProblem(text: string): string | undefined {
	const terms = internalTermsInContent(text);
	return terms.length ? `面向读者的内容泄漏了内部工作术语：${terms.join("、")}。把它改成用户能感受到的场景、动作或结果。` : undefined;
}
