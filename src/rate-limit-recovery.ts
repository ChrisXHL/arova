/**
 * 原生 Pi 会先执行自己的短退避；只有它明确报告“重试最终失败”后，本层才接管，
 * 避免和 Pi 内部重试同时提交。这里没有固定次数上限：429 是供应端状态，不是业务失败。
 */
export class RateLimitRecovery {
	private tail = "";
	private attempts = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disabled = false;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly callbacks: {
		onWait: (delayMs: number, attempt: number, requestId?: string) => void;
		onRetry: (attempt: number) => void;
	};

	constructor(callbacks: {
		onWait: (delayMs: number, attempt: number, requestId?: string) => void;
		onRetry: (attempt: number) => void;
	}, options: { baseDelayMs?: number; maxDelayMs?: number } = {}) {
		this.callbacks = callbacks;
		const configuredBase = options.baseDelayMs ?? Number(process.env.GOAL_MODE_RATE_LIMIT_BASE_MS ?? 30_000);
		const configuredMax = options.maxDelayMs ?? Number(process.env.GOAL_MODE_RATE_LIMIT_MAX_MS ?? 600_000);
		this.baseDelayMs = Number.isFinite(configuredBase) && configuredBase > 0 ? Math.floor(configuredBase) : 30_000;
		this.maxDelayMs = Number.isFinite(configuredMax) && configuredMax >= this.baseDelayMs ? Math.floor(configuredMax) : Math.max(this.baseDelayMs, 600_000);
	}

	observeTerminal(data: string): void {
		if (this.disabled) return;
		const clean = data.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r/g, "\n");
		this.tail = `${this.tail}${clean}`.slice(-8_000);
		const rateLimited = /\b429\b|requests are too frequent|too many requests|rate.?limit|请求过于频繁/i.test(this.tail);
		const retriesExhausted = /retry failed after|auto.?retry.{0,40}(?:failed|cancelled)|retry cancelled|(?:auto-)?compaction failed|summarization failed|重试.{0,20}(?:失败|取消)|压缩.{0,20}失败/i.test(this.tail);
		if (!rateLimited || !retriesExhausted || this.timer) return;
		this.attempts++;
		const delayMs = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(8, this.attempts - 1));
		const requestId = /request\s*id\s*[:：]\s*([\w-]+)/i.exec(this.tail)?.[1];
		this.tail = "";
		this.callbacks.onWait(delayMs, this.attempts, requestId);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.callbacks.onRetry(this.attempts);
		}, delayMs);
	}

	/** 真用户开始新输入或一轮成功后，旧 429 的退避代际作废。 */
	reset(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.tail = "";
		this.attempts = 0;
		this.disabled = false;
	}

	cancel(): void {
		this.reset();
		this.disabled = true;
	}
}

export const RATE_LIMIT_RESUME_PROMPT = "【系统限流恢复】请继续上一条尚未完成的用户任务；不要改变主目标，先确认当前状态，再从中断点恢复。";
