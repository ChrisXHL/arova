import type { GoalModeState } from "./state.ts";

// 监督策略已模块化迁移到 policy.ts（core 常驻系统提示 + 领域模块每轮按任务类型注入）。
// 这里只保留 UI 事件类型。

/** 归一化后喂给 UI（监督面板）的事件。 */
export type UIEvent =
	| { kind: "supervisor"; sub: "text" | "tool" | "tool-result" | "turn" | "suggest"; text?: string }
	| { kind: "state"; state: GoalModeState }
	| { kind: "log"; level: "info" | "warn"; text: string }
	| { kind: "drive"; text: string; round: number } // 自动回灌：把重做指令发回执行端
	| { kind: "objective"; status: "reached" | "halted"; reason?: string; state: GoalModeState }
	| { kind: "done"; reason: "executor-exit" | "stopped"; state: GoalModeState }
	// 历史变了（开单/收单）→ 前端立刻刷新侧栏和项目页，别等会话结束
	| { kind: "history-changed"; cwd: string };
