import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

/**
 * 一个最小的 `pi --mode rpc` 子进程驱动。
 *
 * 改写自 @earendil-works/pi-orchestrator 的 rpc-process.ts（该包未发布到 npm），
 * 去掉 Radius/UI 桥接，直接 spawn PATH 上的 `pi` 二进制。
 * 协议：行分隔 JSON —— 写入 RpcCommand，stdout 上回 {type:"response"} 或事件流。
 */
export class RpcProcess {
	readonly process: ChildProcess;
	private exited = false;
	private nextId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pending = new Map<string, { resolve(r: RpcResponse): void; reject(e: Error): void }>();
	private readonly eventListeners = new Set<(e: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(e?: Error) => void>();

	constructor(options: { cwd: string; piBin?: string; args?: string[]; env?: NodeJS.ProcessEnv }) {
		this.process = spawn(options.piBin ?? "pi", ["--mode", "rpc", ...(options.args ?? [])], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) throw new Error("无法创建 RPC 子进程 stdio");
		this.attach();
	}

	private attach(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			let nl: number;
			while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
				const line = this.stdoutBuffer.slice(0, nl).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
				if (line) this.handleLine(line);
			}
		});
		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
		});
		this.process.once("exit", (code, signal) => {
			this.exited = true;
			const err = new Error(`pi rpc 退出 (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			for (const [id, p] of this.pending) {
				this.pending.delete(id);
				p.reject(err);
			}
			for (const l of this.exitListeners) l(code === 0 ? undefined : err);
		});
	}

	private handleLine(line: string): void {
		let parsed: { type?: string; id?: string };
		try {
			parsed = JSON.parse(line);
		} catch {
			return; // 非 JSON 行（启动噪声等）直接忽略
		}
		if (parsed.type === "response" && parsed.id) {
			const p = this.pending.get(parsed.id);
			if (p) {
				this.pending.delete(parsed.id);
				p.resolve(parsed as RpcResponse);
			}
			return;
		}
		// 其余皆视作 AgentSessionEvent
		for (const l of this.eventListeners) l(parsed as AgentSessionEvent);
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited) throw new Error(`pi rpc 已退出. Stderr: ${this.stderrBuffer}`);
		const id = command.id ?? `gm_${++this.nextId}_${randomUUID()}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify({ ...command, id })}\n`, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(err);
				}
			});
		});
	}

	onEvent(listener: (e: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (e?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	getStderr(): string {
		return this.stderrBuffer;
	}

	async dispose(timeoutMs = 2_000): Promise<void> {
		if (this.exited) return;
		this.process.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			this.process.once("exit", finish);
			const timer = setTimeout(() => {
				if (!this.exited) this.process.kill("SIGKILL");
				finish();
			}, timeoutMs);
		});
	}
}

export function createRpcProcess(options: { cwd: string; piBin?: string; args?: string[]; env?: NodeJS.ProcessEnv }): RpcProcess {
	return new RpcProcess(options);
}
