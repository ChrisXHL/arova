/** 把首条真实用户输入压成侧栏可读、稳定的会话标题；不额外调用模型，也不增加启动延迟。 */
export function automaticSessionTitle(text: string, limit = 32): string {
	const clean = text
		.replace(/\s+/g, " ")
		// URL 只吞 URL 自己，不能把紧跟在链接后的中文需求一并吞掉。
		.replace(/https?:\/\/([A-Za-z0-9.-]+)(?:\/[A-Za-z0-9_./?=&%#-]*)?/gi, "$1")
		.replace(/^(请|麻烦|能否|可以|帮我|帮忙|我要|我想|想要|研究一下|研究下|分析一下|分析下|看看|看下)\s*/u, "")
		.split(/[。！？\n]/u)[0]
		.trim();
	if (!clean) return "";
	const chars = [...clean];
	return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : clean;
}
