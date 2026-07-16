import { readFileSync } from "node:fs";
import { sessionFiles, parseTranscriptLines } from "./transcript.ts";
import { visibleUserText } from "./session-watch.ts";

/**
 * 只有真实的用户输入才算一场会话已经开始。pi 启动时可能会写入系统提示或 skill
 * 注入内容；这些不是用户互动，不能因此浪费一个空会话。
 */
export function sessionHasUserInteraction(cwd: string, sessionId: string): boolean {
	if (!/^[\w.-]+$/.test(sessionId)) return true;
	for (const file of sessionFiles(cwd, sessionId) ?? []) {
		const lines = readFileSync(file, "utf8").split("\n");
		for (const message of parseTranscriptLines(lines)) {
			if (message.role === "user" && visibleUserText(message.text).trim()) return true;
		}
	}
	return false;
}
