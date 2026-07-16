import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { envWithLocalPath, findPi } from "./local-env.ts";
import { createRpcProcess } from "./rpc-process.ts";
import { parseQueueRunResult, queueExecutorSystemPrompt, queueItemPrompt, queuePromptHash } from "./queue-prompt.ts";
import { queueDir } from "./queue-store.ts";
import type { QueueContract, QueueItem, QueueRunResult } from "./queue-types.ts";

export interface QueueRpcProcess {
	send(command: RpcCommand): Promise<RpcResponse>;
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	onExit(listener: (error?: Error) => void): () => void;
	dispose(timeoutMs?: number): Promise<void>;
}

export interface QueueWorkerOptions {
	cwd: string;
	provider?: string;
	contract: QueueContract;
	item: QueueItem;
	input: unknown;
	workerId: string;
	attemptId: string;
	timeoutMs?: number;
	processFactory?: (options: { cwd: string; piBin: string; args: string[]; env: NodeJS.ProcessEnv }) => QueueRpcProcess;
}

export interface QueueWorkerResult {
	result: QueueRunResult;
	rawText: string;
	sessionId: string;
	promptHash: string;
}

export type QueueWorkerEvent =
	| { kind: "status"; status: "starting" | "running" | "finished" | "aborting" }
	| { kind: "text"; text: string }
	| { kind: "tool"; toolName: string };

function responseData<T>(response: RpcResponse, command: string): T {
	if (!response.success) throw new Error(`Pi RPC ${command} 失败：${response.error}`);
	if (response.command !== command) throw new Error(`Pi RPC 响应错位：期望 ${command}，收到 ${response.command}`);
	return (response as RpcResponse & { data: T }).data;
}

export class QueueWorker extends EventEmitter {
	private readonly options: QueueWorkerOptions;
	private rpc?: QueueRpcProcess;
	private cancelled = false;

	constructor(options: QueueWorkerOptions) {
		super();
		this.options = options;
	}

	private ev(event: QueueWorkerEvent): void {
		this.emit("event", event);
	}

	async run(): Promise<QueueWorkerResult> {
		const { cwd, provider, contract, item, input, workerId, attemptId } = this.options;
		const systemPrompt = queueExecutorSystemPrompt(contract);
		const itemPrompt = queueItemPrompt(contract, item, input, attemptId);
		const promptHash = queuePromptHash(systemPrompt, itemPrompt);
		const sessionDir = join(queueDir(cwd, contract.queueId), "items", item.id, "attempts", attemptId, "session");
		mkdirSync(sessionDir, { recursive: true });
		const thinkingExt = join(dirname(fileURLToPath(import.meta.url)), "thinking-chain-extension.ts");
		const args = ["--session-dir", sessionDir, "--offline", "--append-system-prompt", systemPrompt, "--extension", thinkingExt];
		if (provider) args.push("--provider", provider);
		const factory = this.options.processFactory ?? ((options) => createRpcProcess(options));
		this.ev({ kind: "status", status: "starting" });
		this.rpc = factory({ cwd, piBin: findPi(), args, env: { ...envWithLocalPath(), GOAL_MODE_QUEUE_WORKER: "1" } });

		let rawText = "";
		let settled = false;
		let resolveTurn!: () => void;
		let rejectTurn!: (error: Error) => void;
		const turn = new Promise<void>((resolve, reject) => {
			resolveTurn = resolve;
			rejectTurn = reject;
		});
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			error ? rejectTurn(error) : resolveTurn();
		};
		const offEvent = this.rpc.onEvent((event) => {
			const e = event as AgentSessionEvent & {
				type: string;
				toolName?: string;
				assistantMessageEvent?: { type?: string; delta?: string };
				message?: { role?: string; stopReason?: string; errorMessage?: string };
			};
			if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
				const delta = e.assistantMessageEvent.delta ?? "";
				rawText += delta;
				if (delta) this.ev({ kind: "text", text: delta });
			} else if (e.type.includes("tool_call") && e.toolName) {
				this.ev({ kind: "tool", toolName: e.toolName });
			} else if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") {
				finish(new Error(e.message.errorMessage || "执行端模型调用失败"));
			} else if (e.type === "agent_end") {
				finish();
			}
		});
		const offExit = this.rpc.onExit((error) => {
			if (!settled) finish(error ?? new Error("Pi RPC 在 Item 完成前退出"));
		});
		const timeoutMs = this.options.timeoutMs ?? contract.itemTimeoutMs ?? 0;
		const timeout = timeoutMs > 0
			? setTimeout(() => {
				void this.rpc?.send({ type: "abort" }).catch(() => undefined);
				finish(new Error(`QueueItem 执行超时（${timeoutMs}ms，用户配置的单条预算）`));
			}, timeoutMs)
			: undefined;

		try {
			const state = responseData<{ sessionId: string }>(await this.rpc.send({ type: "get_state" }), "get_state");
			await this.rpc.send({ type: "set_auto_compaction", enabled: false });
			await this.rpc.send({ type: "set_auto_retry", enabled: false });
			if (this.cancelled) throw new Error("QueueItem 已取消");
			this.ev({ kind: "status", status: "running" });
			await this.rpc.send({ type: "prompt", message: itemPrompt });
			await turn;
			if (this.cancelled) throw new Error("QueueItem 已取消");
			try {
				const last = responseData<{ text: string | null }>(await this.rpc.send({ type: "get_last_assistant_text" }), "get_last_assistant_text");
				if (last.text?.trim()) rawText = last.text;
			} catch {
				// 已收集流式文本时，取最后消息失败不应丢掉可解析结果。
			}
			const result = parseQueueRunResult(rawText);
			this.ev({ kind: "status", status: "finished" });
			return { result, rawText, sessionId: state.sessionId || attemptId, promptHash };
		} finally {
			if (timeout) clearTimeout(timeout);
			offEvent();
			offExit();
			await this.rpc.dispose();
			this.rpc = undefined;
		}
	}

	async abort(): Promise<void> {
		this.cancelled = true;
		this.ev({ kind: "status", status: "aborting" });
		if (!this.rpc) return;
		await Promise.allSettled([
			this.rpc.send({ type: "abort" }),
			this.rpc.send({ type: "abort_retry" }),
			this.rpc.send({ type: "abort_bash" }),
		]);
	}
}
