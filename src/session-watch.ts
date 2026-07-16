import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 递归找目录下所有 .jsonl（pi --session-dir 可能把文件嵌在 <编码cwd>/ 子目录里）。 */
function findJsonl(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) findJsonl(p, out);
		else if (e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

/**
 * 只读旁观执行端：tail pi 写出的 session jsonl。
 *   - 用户发的 message(role=user) → 作为(进化的)目标
 *   - assistant 产出后文件静默一会 → 视为执行端"一轮结束"，触发一次监督
 * 完全不写、不驱动执行端，纯观察。
 */
export interface WatchEvents {
	"user-task": (text: string) => void;
	"turn-end": (assistantText: string) => void;
	"turn-cancelled": (reason: string) => void;
}

/** pi 会把自动注入的 skill 正文和真实提问放在同一条 user message；监督/历史只应看用户真正输入的部分。 */
export function visibleUserText(raw: string): string {
	return raw
		.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>\s*/gi, "")
		.trim();
}

export class SessionWatch extends EventEmitter {
	private readonly dir: string;
	private file?: string;
	private offset = 0;
	private buf = "";
	private timer?: NodeJS.Timeout;
	private idle?: NodeJS.Timeout;
	private pendingAssistant = "";
	private sawAssistantSinceTask = false;
	private startAtEnd = false;
	private positioned = false;

	constructor(sessionDir: string) {
		super();
		this.dir = sessionDir;
	}

	start(opts: { fromEnd?: boolean } = {}) {
		this.startAtEnd = opts.fromEnd ?? false;
		// 续接已有对话时，跳过启动前已经存在的历史。这里不能把“第一次
		// 找到 jsonl”一概当成历史：复用一个从未互动过的空会话时，Pi 往往
		// 会在用户首次提交后才创建 jsonl；若那时才跳到末尾，首个 user
		// message 会被吞掉，监督端就永远没有 goal、也不会验收。
		if (this.startAtEnd) {
			const existing = this.resolveFile();
			if (existing) {
				try {
					this.offset = statSync(existing).size;
				} catch {
					this.offset = 0;
				}
			}
			// 无论是否已有文件都完成初始定位。若启动时为空目录，稍后出现的
			// jsonl 属于本次会话，必须从 offset=0 正常解析。
			this.positioned = true;
		}
		this.timer = setInterval(() => this.poll(), 400);
		this.poll();
	}
	stop() {
		if (this.timer) clearInterval(this.timer);
		if (this.idle) clearTimeout(this.idle);
	}

	private resolveFile(): string | undefined {
		if (this.file) return this.file;
		try {
			const jsonl = findJsonl(this.dir);
			if (jsonl.length === 0) return undefined;
			this.file = jsonl.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
			return this.file;
		} catch {
			return undefined;
		}
	}

	private poll() {
		const f = this.resolveFile();
		if (!f) return;
		let size: number;
		try {
			size = statSync(f).size;
		} catch {
			return;
		}
		// 续接旧 session 时，旧 JSONL 只是上下文，不是刚发生的新消息。
		// 第一次定位直接站到文件末尾，否则每次“接着聊”都会把全部历史 user 消息重新 emit 一遍。
		if (this.startAtEnd && !this.positioned) {
			this.offset = size;
			this.positioned = true;
			return;
		}
		this.positioned = true;
		if (size <= this.offset) return;
		// 必须按【字节】切：session 全是多字节中文，用字符 slice 会和字节 offset 错位。
		// offset 永远落在某个 "\n"(单字节)之后，按字节切到文件末尾不会劈裂多字节字符。
		const chunk = readFileSync(f).subarray(this.offset).toString("utf8");
		this.offset = size;
		this.buf += chunk;
		let nl: number;
		let advanced = false;
		while ((nl = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (line) {
				this.handleLine(line);
				advanced = true;
			}
		}
		// 任何新内容（含一轮里几十条 toolCall/toolResult）都重置静默计时——
		// 这样抓数据的网络停顿不会被误判成"一轮结束"。
		if (advanced) {
			if (this.idle) clearTimeout(this.idle);
			this.idle = setTimeout(() => this.onIdle(), 3000);
		}
	}

	/** 文件真正静默后才算一轮结束——且必须执行端已产出最终文本答案，否则还在工具阶段，不触发。 */
	private onIdle() {
		const text = this.pendingAssistant.trim();
		if (!text) return; // 还没有可见答案（纯 thinking/toolCall 阶段），继续等
		this.pendingAssistant = "";
		this.sawAssistantSinceTask = false;
		this.emit("turn-end", text);
	}

	private handleLine(line: string) {
		let o: { type?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> } };
		try {
			o = JSON.parse(line);
		} catch {
			return;
		}
		if (o.type !== "message" || !o.message) return;
		const { role, content = [] } = o.message;
		const textOf = (items: typeof content) => items.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

		if (role === "user") {
			const t = visibleUserText(textOf(content));
			if (t) {
				this.sawAssistantSinceTask = false;
				this.pendingAssistant = "";
				this.emit("user-task", t);
			}
		} else if (role === "assistant") {
			if (o.message.stopReason === "aborted") {
				// 用户取消的是整轮生成：残余文本不能再被静默计时器误判成正常完成。
				if (this.idle) clearTimeout(this.idle);
				this.pendingAssistant = "";
				this.sawAssistantSinceTask = false;
				this.emit("turn-cancelled", o.message.errorMessage || "执行端已取消生成");
				return;
			}
			// 一轮里大量 assistant 消息只有 thinking+toolCall(文本为空)，只累积真正的可见文本
			this.sawAssistantSinceTask = true;
			this.pendingAssistant += textOf(content);
		}
	}
}
