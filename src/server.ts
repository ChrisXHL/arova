import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SessionWatch, visibleUserText } from "./session-watch.ts";
import { readSupervisorHistory, SupervisorHistoryWriter } from "./supervisor-history.ts";
import type { UIEvent } from "./ui-events.ts";
import type { LoopEvent } from "./loop.ts";
import { parseTranscriptLines, readTranscriptPage, sessionFiles } from "./transcript.ts";
import { sessionHasUserInteraction } from "./session-reuse.ts";
import { automaticSessionTitle } from "./session-title.ts";
import { listQueueIds, QueueStore, queueStats } from "./queue-store.ts";
import type { QueueContractSpec, QueueItemInput, QueueWireEvent } from "./queue-types.ts";
import { RateLimitRecovery, RATE_LIMIT_RESUME_PROMPT } from "./rate-limit-recovery.ts";
import { isSupervisorDirective } from "./task-contract.ts";

/**
 * GUI 服务：
 *   左窗格 = 真实交互式 pi（node-pty）经 WS /pty 接到浏览器 xterm —— 执行交互 100% 原生
 *   右窗格 = 监督面板，监督只读 tail 执行端 session 后把核查结果经 SSE /events 推来
 *   DEMO=1 → 不起 pi，回放假监督事件，纯验证面板
 */
const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const RENDERER = join(ROOT, "renderer");
const XTERM = join(ROOT, "node_modules", "@xterm");
const PORT = Number(process.env.PORT ?? 5780);
const DEMO = process.env.DEMO === "1";
const PROVIDER = process.env.PI_PROVIDER;
const WORKDIR = process.env.WORKDIR || process.cwd();

const clients = new Set<ServerResponse>();
type WireEvent = (UIEvent & { runToken?: string }) | LoopEvent | QueueWireEvent;
function broadcast(e: WireEvent) {
	const line = `data: ${JSON.stringify(e)}\n\n`;
	for (const res of clients) res.write(line);
}

// SSE 只推队列摘要。几百个 Item 的完整快照若在每个状态变化时广播，会形成 O(n²) 数据量；
// 明细由分页 API 按需读取，worker 文本则保留在 attempt/session 文件里。
function compactQueueEvent(event: QueueWireEvent): QueueWireEvent | undefined {
	if (event.kind === "queue-worker") return undefined;
	if (event.kind !== "queue-snapshot") return event;
	return { ...event, snapshot: { ...event.snapshot, items: [] } };
}

function broadcastQueue(event: QueueWireEvent): void {
	const compact = compactQueueEvent(event);
	if (compact) broadcast(compact);
}

type ActiveLoop = {
	stop(): void;
	on(event: "event", listener: (event: LoopEvent) => void): unknown;
	runOnce(): Promise<unknown>;
};
let activeLoop: ActiveLoop | undefined;
const activeRuns = new Map<string, { cwd: string; sessionId: string }>();

type ActiveQueueCoordinator = {
	store: QueueStore;
	on(event: "event", listener: (event: QueueWireEvent) => void): unknown;
	start(): Promise<void>;
	pause(mode?: "drain" | "immediate"): Promise<void>;
	resume(): Promise<void>;
	cancel(): Promise<void>;
	retryItem(itemId: string): Promise<void>;
	waiveItem(itemId: string, reason: string, actor?: string): Promise<void>;
	setParallel(enabled: boolean, concurrency?: number): Promise<void>;
	getSnapshot(): ReturnType<QueueStore["getSnapshot"]>;
	dispose(): Promise<void>;
};
const activeQueues = new Map<string, ActiveQueueCoordinator>();
const queueKey = (cwd: string, queueId: string) => `${cwd}\0${queueId}`;
const recoveredQueues = new Set<string>();
const queueRecoveries = new Map<string, Promise<void>>();

/**
 * 队列恢复按项目懒执行：打开应用时不能扫描每个项目的几百条队列快照。
 * 用户进入某项目或操作某队列时，先把上次失联的租约放回重试队列，再交给 coordinator。
 */
async function recoverPersistedQueue(cwd: string, queueId: string): Promise<void> {
	const key = queueKey(cwd, queueId);
	if (recoveredQueues.has(key)) return;
	const pending = queueRecoveries.get(key);
	if (pending) return pending;
	const recovery = (async () => {
		const store = new QueueStore(cwd, queueId);
		await store.recoverAfterRestart();
		let snapshot = store.getSnapshot();
		if (snapshot.state === "running" || snapshot.state === "pausing") {
			await store.patchQueue({ state: "paused", pausedReason: "应用曾中断，活动 Item 已安全放回重试队列" });
		} else if (snapshot.state === "cancelling") {
			for (const item of snapshot.items) {
				if (["pending", "retry_wait", "blocked", "leased"].includes(item.status)) {
					await store.patchItem(item.id, { status: "cancelled", leaseOwner: undefined, leaseUntil: undefined });
				}
			}
			await store.patchQueue({ state: "cancelled", pausedReason: "上次取消已完成" });
		}
		snapshot = store.getSnapshot();
		recoveredQueues.add(key);
		if (snapshot.state === "paused" || snapshot.state === "cancelled") {
			broadcastQueue({ kind: "queue-snapshot", queueId, snapshot, stats: queueStats(snapshot) });
		}
	})().finally(() => queueRecoveries.delete(key));
	queueRecoveries.set(key, recovery);
	return recovery;
}

async function ensureQueueCoordinator(cwd: string, queueId: string): Promise<ActiveQueueCoordinator> {
	const key = queueKey(cwd, queueId);
	const existing = activeQueues.get(key);
	if (existing) return existing;
	await recoverPersistedQueue(cwd, queueId);
	const recoveredExisting = activeQueues.get(key);
	if (recoveredExisting) return recoveredExisting;
	const { QueueCoordinator } = await import("./queue-coordinator.ts");
	const coordinator = new QueueCoordinator({ cwd, queueId, provider: PROVIDER }) as ActiveQueueCoordinator;
	coordinator.on("event", (event) => {
		broadcastQueue(event);
		if (event.kind === "queue-snapshot" && ["cancelled", "completed", "completed_with_waivers"].includes(event.snapshot.state)) {
			setTimeout(() => {
				if (activeQueues.get(key) !== coordinator) return;
				activeQueues.delete(key);
				void coordinator.dispose();
			}, 100);
		}
	});
	activeQueues.set(key, coordinator);
	return coordinator;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

function readJsonBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
			if (Buffer.byteLength(raw) > limit) reject(new Error("request body too large"));
		});
		req.on("end", () => {
			try { resolve(JSON.parse(raw || "{}") as Record<string, unknown>); }
			catch (error) { reject(error); }
		});
		req.on("error", reject);
	});
}

function assertProjectDir(cwd: string): void {
	if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error("bad cwd");
}

function queueSummary(store: QueueStore) {
	const snapshot = store.getSnapshot();
	return { ...snapshot, items: undefined, stats: queueStats(snapshot) };
}

async function handleQueueRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	try {
		if (url.pathname === "/queues" && req.method === "GET") {
			const cwd = url.searchParams.get("cwd") || "";
			assertProjectDir(cwd);
			const ids = listQueueIds(cwd);
			await Promise.all(ids.map((id) => recoverPersistedQueue(cwd, id)));
			return sendJson(res, 200, { queues: ids.map((id) => queueSummary(new QueueStore(cwd, id))) });
		}
		if (url.pathname === "/queues" && req.method === "POST") {
			const body = await readJsonBody(req);
			const cwd = String(body.cwd || "");
			assertProjectDir(cwd);
			const contract = body.contract as QueueContractSpec;
			const items = body.items as QueueItemInput[];
			if (!contract?.primaryGoal || !Array.isArray(items) || !items.length) throw new Error("contract.primaryGoal 和 items 必填");
			const configured = body.parallelEnabled ? Number(body.concurrency || 2) : 1;
			const store = QueueStore.create(cwd, contract, items, { title: String(body.title || ""), configuredConcurrency: configured });
			recoveredQueues.add(queueKey(cwd, store.queueId));
			touchProject(cwd);
			broadcastQueue({ kind: "queue-snapshot", queueId: store.queueId, snapshot: store.getSnapshot(), stats: queueStats(store.getSnapshot()) });
			return sendJson(res, 201, { snapshot: store.getSnapshot(), stats: queueStats(store.getSnapshot()) });
		}

		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] !== "queues" || !parts[1]) return sendJson(res, 404, { error: "queue route not found" });
		const queueId = parts[1];
		const actionBody = req.method === "POST" ? await readJsonBody(req) : {};
		const cwd = url.searchParams.get("cwd") || String(actionBody.cwd || "");
		assertProjectDir(cwd);
		await recoverPersistedQueue(cwd, queueId);
		const store = new QueueStore(cwd, queueId);

		if (req.method === "GET" && parts.length === 2) {
			const snapshot = store.getSnapshot();
			const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
			const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 100)));
			const status = url.searchParams.get("status");
			const filtered = status ? snapshot.items.filter((item) => item.status === status) : snapshot.items;
			return sendJson(res, 200, {
				snapshot: { ...snapshot, items: filtered.slice(offset, offset + limit) },
				stats: queueStats(snapshot),
				page: { offset, limit, returned: filtered.slice(offset, offset + limit).length, filteredTotal: filtered.length },
			});
		}

		if (req.method === "GET" && parts[2] === "items" && parts[3]) {
			const item = store.getSnapshot().items.find((entry) => entry.id === parts[3]);
			if (!item) return sendJson(res, 404, { error: "item not found" });
			return sendJson(res, 200, { item, input: store.readItemInput(item.id) });
		}

		if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
		const body = actionBody;
		const coordinator = await ensureQueueCoordinator(cwd, queueId);
		const action = parts[2];
		if (action === "start") await coordinator.start();
		else if (action === "pause") await coordinator.pause(body.mode === "immediate" ? "immediate" : "drain");
		else if (action === "resume") await coordinator.resume();
		else if (action === "cancel") await coordinator.cancel();
		else if (action === "parallel") await coordinator.setParallel(Boolean(body.enabled), Number(body.concurrency || 2));
		else if (action === "items" && parts[3] && parts[4] === "retry") await coordinator.retryItem(parts[3]);
		else if (action === "items" && parts[3] && parts[4] === "waive") await coordinator.waiveItem(parts[3], String(body.reason || ""));
		else return sendJson(res, 404, { error: "unknown queue action" });
		const snapshot = coordinator.getSnapshot();
		return sendJson(res, 200, { snapshot, stats: queueStats(snapshot) });
	} catch (error) {
		return sendJson(res, /not found|不存在/i.test(String(error)) ? 404 : 400, { error: String(error instanceof Error ? error.message : error) });
	}
}

// pi 的执行器和监督器会连带加载大批 agent 依赖。项目壳启动不需要它们，真正打开会话时再加载。
async function loadLiveRuntime() {
	const [ptyExec, supervisor, policy] = await Promise.all([
		import("./pty-exec.ts"),
		import("./supervisor.ts"),
		import("./policy.ts"),
	]);
	return { spawnPiPty: ptyExec.spawnPiPty, Supervisor: supervisor.Supervisor, executorBrief: policy.executorBrief };
}

// —— 项目列表（全局，跨项目）+ 每个项目的历史（读它自己的 .goal-mode-pi/loop-log.md）——
const GLOBAL_DIR = join(homedir(), ".goal-mode-pi");
const PROJ_FILE = join(GLOBAL_DIR, "projects.json");
interface ProjEntry {
	path: string;
	addedAt: number;
	lastOpenedAt: number;
}
function loadProjects(): ProjEntry[] {
	try {
		return (JSON.parse(readFileSync(PROJ_FILE, "utf8")).projects as ProjEntry[]) || [];
	} catch {
		return [];
	}
}
function saveProjects(p: ProjEntry[]) {
	// 写失败（权限/磁盘满）不能抛：这函数在 ws 连接回调里被同步调用，抛出会掀翻整个 server → 所有 pty 断连
	try {
		mkdirSync(GLOBAL_DIR, { recursive: true });
		writeFileSync(PROJ_FILE, JSON.stringify({ projects: p }, null, 2));
	} catch (err) {
		console.error("saveProjects 失败（已忽略，不影响会话）:", String(err));
	}
}
function touchProject(path: string) {
	const p = loadProjects();
	const e = p.find((x) => x.path === path);
	if (e) e.lastOpenedAt = Date.now();
	else p.unshift({ path, addedAt: Date.now(), lastOpenedAt: Date.now() });
	p.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
	saveProjects(p);
}
function projectList() {
	// 首屏只需要项目名；历史在用户选中项目后才读，不能让一个长项目拖住整个应用启动。
	return loadProjects().map((e) => ({ ...e, name: basename(e.path), exists: existsSync(e.path) }));
}
/** 历史 = 解析该项目 loop-log.md 的分节（## <iso> <状态>\n目标：…\n- 笔记…）。✅=验过 ⚠=卡住 ○=没验完。 */
function projectHistory(cwd: string, opts: { includeEmptySessions?: boolean } = {}) {
	const f = join(cwd, ".goal-mode-pi", "loop-log.md");
	type HistoryEntry = { time: string; status: "done" | "blocked" | "open" | "running"; goal: string; notes: string[]; session?: string };
	const entries: HistoryEntry[] = [];
	const sessions = new Map<string, HistoryEntry>();
	if (existsSync(f)) {
		for (const block of readFileSync(f, "utf8").split(/\n(?=## )/)) {
			const m = block.match(/^## (\S+) (✅|⚠|○|●)/);
			if (!m) continue;
			const goal = (block.match(/^目标：(.+)$/m)?.[1] ?? "").trim();
			const session = block.match(/^会话：(\S+)$/m)?.[1];
			const notes = [...block.matchAll(/^- (.+)$/gm)].map((x) => x[1]);
			const status: HistoryEntry["status"] = m[2] === "✅" ? "done" : m[2] === "⚠" ? "blocked" : m[2] === "●" ? "running" : "open";
			const entry = { time: m[1], status, goal, notes, session };
			if (!session) entries.push(entry); // loop/老记录没有 session，仍按独立任务展示
			else {
				const old = sessions.get(session);
				if (!old) sessions.set(session, entry);
				else {
					// 一个 session 只是一场对话：首条用户消息当标题，最新块提供状态/活动时间/核查笔记。
					old.time = entry.time;
					old.status = entry.status;
					old.notes = entry.notes;
				}
			}
		}
	}
	// 标题以首条真实用户输入为准。旧记录即使当时未写成功，也会在读取时自动修复。
	for (const entry of sessions.values()) {
		if (entry.goal === "新会话" || /^<skill\b/i.test(entry.goal)) {
			const firstUser = readSessionTitle(cwd, entry.session!);
			if (firstUser) entry.goal = firstUser;
			else if (!opts.includeEmptySessions) continue; // 从未输入的空壳不应占一条历史
		}
		entries.push(entry);
	}
	entries.sort((a, b) => b.time.localeCompare(a.time)); // 最新活动在前
	let pending = 0;
	try {
		const bl = readFileSync(join(cwd, ".goal-mode-pi", "backlog.md"), "utf8");
		pending = (bl.match(/^\s*-\s*\[\s\]/gm) || []).length;
	} catch {
		/* 没有 backlog */
	}
	return { entries, pending };
}

/** 最近创建、但用户从未输入过的 live 会话可以安全复用。 */
function reusableEmptySession(cwd: string): string | undefined {
	return projectHistory(cwd, { includeEmptySessions: true }).entries.find((entry) =>
		entry.session && entry.goal === "新会话" && !sessionHasUserInteraction(cwd, entry.session),
	)?.session;
}

/** 一条历史分节的文本（●=进行中 ✅=验过 ⚠=卡住 ○=没验完）。 */
function historyBlock(time: string, status: "●" | "✅" | "⚠" | "○", goal: string, notes: string[], session?: string) {
	const g = goal.replace(/\s*\n+\s*/g, " ").trim().slice(0, 300);
	const lines = notes
		.filter(Boolean)
		.map((n) => `- ${n.replace(/\s*\n+\s*/g, " ").slice(0, 200)}`)
		.join("\n");
	const sess = session ? `会话：${session}\n` : "";
	return `## ${time} ${status}\n目标：${g}\n${sess}${lines ? `${lines}\n` : ""}\n`;
}

/** live 对话历史以 session 为唯一键：整场会话永远只有一条，后续消息只更新它。 */
function upsertSessionHistory(cwd: string, session: string, goal: string, status: "●" | "✅" | "⚠" | "○", notes: string[]) {
	if (!session || !goal.trim()) return;
	const dir = join(cwd, ".goal-mode-pi");
	const f = join(dir, "loop-log.md");
	mkdirSync(dir, { recursive: true });
	const now = new Date().toISOString();
	const replacement = historyBlock(now, status, goal, notes, session).trimEnd();
	let raw = "";
	try {
		raw = readFileSync(f, "utf8");
	} catch {
		/* 首场会话 */
	}
	const blocks = raw ? raw.split(/\n(?=## )/) : [];
	let first = -1;
	const kept: string[] = [];
	for (const block of blocks) {
		if (block.match(/^会话：(\S+)$/m)?.[1] === session) {
			if (first < 0) first = kept.length;
			continue; // 顺手折叠这个 session 过去已产生的重复块
		}
		kept.push(block.trimEnd());
	}
	if (first < 0) kept.push(replacement);
	else kept.splice(first, 0, replacement);
	writeFileSync(f, `${kept.filter(Boolean).join("\n")}\n`);
}

const sessionTitleCache = new Map<string, string>();

/** 标题从首条真实用户输入生成；空会话不缓存，下一次输入后仍可被自动命名。 */
function readSessionTitle(cwd: string, id: string): string {
	const key = `${cwd}\0${id}`;
	if (sessionTitleCache.has(key)) return sessionTitleCache.get(key) ?? "";
	const files = sessionFiles(cwd, id) ?? [];
	for (const f of files) {
		for (const msg of parseTranscriptLines(readFileSync(f, "utf8").split("\n"))) {
			if (msg.role === "user" && msg.text) {
				const title = automaticSessionTitle(msg.text);
				if (title) sessionTitleCache.set(key, title);
				return title;
			}
		}
	}
	return "";
}


const VENDOR: Record<string, string> = {
	"/vendor/xterm.js": join(XTERM, "xterm", "lib", "xterm.js"),
	"/vendor/xterm.css": join(XTERM, "xterm", "css", "xterm.css"),
	"/vendor/addon-fit.js": join(XTERM, "addon-fit", "lib", "addon-fit.js"),
};

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

	if (url.pathname === "/events") {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
		res.write(`data: ${JSON.stringify({ kind: "log", level: "info", text: DEMO ? "演示模式" : "已连接" })}\n\n`);
		clients.add(res);
		req.on("close", () => clients.delete(res));
		if (DEMO) runDemo();
		return;
	}

	if (url.pathname === "/defaults") {
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ home: homedir() }));
		return;
	}

	if (url.pathname === "/queues" || url.pathname.startsWith("/queues/")) {
		void handleQueueRequest(req, res, url);
		return;
	}

	// 新会话不是一次性资源：若上一次只是打开终端却还没输入，前端应继续用它。
	if (url.pathname === "/sessions/reusable" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return void res.writeHead(400).end("bad cwd");
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ session: reusableEmptySession(cwd) || "" }));
		return;
	}

	// —— 项目与历史 ——
	if (url.pathname === "/projects" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects: projectList() }));
		return;
	}
	if ((url.pathname === "/projects/add" || url.pathname === "/projects/remove") && req.method === "POST") {
		let raw = "";
		req.on("data", (c) => (raw += c));
			req.on("end", async () => {
			try {
				const p = (JSON.parse(raw || "{}").path as string) || "";
				if (url.pathname === "/projects/add") {
					if (!p || !existsSync(p) || !statSync(p).isDirectory()) return void res.writeHead(400).end("bad path");
					touchProject(p);
				} else {
					saveProjects(loadProjects().filter((x) => x.path !== p));
				}
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ projects: projectList() }));
			} catch (err) {
				res.writeHead(400).end(String(err));
			}
		});
		return;
	}
	if (url.pathname === "/history" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		if (!cwd || !existsSync(cwd)) return void res.writeHead(400).end("bad cwd");
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(projectHistory(cwd)));
		return;
	}
	if (url.pathname === "/transcript" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		const id = url.searchParams.get("id") || "";
		const beforeRaw = url.searchParams.get("before");
		const before = beforeRaw == null ? undefined : Number(beforeRaw);
		if (!cwd || !existsSync(cwd)) return void res.writeHead(400).end("bad cwd");
		if (beforeRaw != null && (!Number.isInteger(before) || before! < 0)) return void res.writeHead(400).end("bad cursor");
		const transcript = readTranscriptPage(cwd, id, before);
		if (!transcript) return void res.writeHead(404).end("no transcript");
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(transcript));
		return;
	}
	if (url.pathname === "/supervisor-history" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		const id = url.searchParams.get("id") || "";
		if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return void res.writeHead(400).end("bad cwd");
		const history = readSupervisorHistory(cwd, id);
		if (!history) return void res.writeHead(404).end("no supervisor history");
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(history));
		return;
	}
	if (url.pathname === "/thinking/latest" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		const run = activeRuns.get(url.searchParams.get("run") || "");
		if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return void res.writeHead(400).end("bad cwd");
		try {
			const file = run?.cwd === cwd
				? join(cwd, ".goal-mode-pi", "runs", run.sessionId, "thinking", "latest.json")
				: join(cwd, ".goal-mode-pi", "thinking", "latest.json");
			const body = readFileSync(file);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
		} catch {
			res.writeHead(404).end("no thinking trace");
		}
		return;
	}
	if (url.pathname === "/context/latest" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || "";
		const run = activeRuns.get(url.searchParams.get("run") || "");
		if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) return void res.writeHead(400).end("bad cwd");
		try {
			const file = run?.cwd === cwd
				? join(cwd, ".goal-mode-pi", "runs", run.sessionId, "context", "latest.json")
				: join(cwd, ".goal-mode-pi", "context", "latest.json");
			const body = readFileSync(file);
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(body);
		} catch {
			res.writeHead(404).end("no context status");
		}
		return;
	}
	if (url.pathname === "/run/info" && req.method === "GET") {
		const run = activeRuns.get(url.searchParams.get("run") || "");
		if (!run) return void res.writeHead(404).end("run not found");
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(run));
		return;
	}

	// —— 循环模式：跑一轮自驱动 loop，所有事件经 SSE 推到看板 ——
	if (url.pathname === "/loop/start" && req.method === "POST") {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", async () => {
			try {
				const cwd = JSON.parse(raw || "{}").cwd as string;
				if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
					return void res.writeHead(400).end("bad cwd");
				}
				touchProject(cwd);
				if (DEMO) {
					runLoopDemo();
					return void res.writeHead(200).end("ok");
				}
				activeLoop?.stop();
				const { Loop } = await import("./loop.ts");
				activeLoop = new Loop({
					workdir: cwd,
					provider: PROVIDER,
					maxGoalsPerRun: Number(process.env.MAX_GOALS ?? 3),
					perGoalTimeoutMs: Number(process.env.GOAL_TIMEOUT_MS ?? 0),
				});
				activeLoop.on("event", (e: LoopEvent) => {
					broadcast(e);
					// loop 每完成一件活就落了历史 → 侧栏/项目页立刻刷
					if (e.kind === "loop" && (e.sub === "goal-done" || e.sub === "round-done")) {
						broadcast({ kind: "history-changed", cwd });
					}
				});
				activeLoop.runOnce().catch((err) => broadcast({ kind: "log", level: "warn", text: `loop 出错: ${String(err)}` }));
				res.writeHead(200).end("ok");
			} catch (err) {
				res.writeHead(400).end(String(err));
			}
		});
		return;
	}
	if (url.pathname === "/loop/stop" && req.method === "POST") {
		activeLoop?.stop();
		res.writeHead(200).end("ok");
		return;
	}

	if (VENDOR[url.pathname]) {
		const ct = url.pathname.endsWith(".css") ? "text/css" : "text/javascript";
		// 先读文件再发头：writeHead 后 readFileSync 若抛错，catch 里再 writeHead 会 ERR_HTTP_HEADERS_SENT 把整个进程干崩
		try {
			const body = readFileSync(VENDOR[url.pathname]);
			res.writeHead(200, { "Content-Type": ct }).end(body);
		} catch {
			res.writeHead(404).end("vendor missing");
		}
		return;
	}

	const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	// 同上：必须先把文件读出来（可能抛），再发响应头，否则 favicon.ico 等不存在的请求会击垮 server → pty ws 断开 → 终端能聚焦却打不了字
	try {
		const ext = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
		const body = readFileSync(join(RENDERER, file));
		res.writeHead(200, { "Content-Type": `${ext}; charset=utf-8` }).end(body);
	} catch {
		res.writeHead(404).end("not found");
	}
});

// —— 左窗格：真实 pi 终端经 WS ——
const wss = new WebSocketServer({ server, path: "/pty" });
wss.on("connection", async (ws, req) => {
	if (DEMO) {
		ws.send("\x1b[90m[DEMO] 这里在真实模式下是一个内嵌的交互式 pi 终端\x1b[0m\r\n");
		return;
	}
	// 用户选的项目文件夹经 ?cwd= 传来；校验是真实目录
	const qcwd = new URL(req.url ?? "/", "http://localhost").searchParams.get("cwd");
	const cwd = qcwd || WORKDIR;
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		ws.send(`\x1b[31m目录不存在：${cwd}\x1b[0m\r\n`);
		ws.close();
		return;
	}
	touchProject(cwd);
	// ?session=<id> → 续接那场会话（点历史"接着聊"）；校验 id 且目录真实存在才续
	const qsess = new URL(req.url ?? "/", "http://localhost").searchParams.get("session") || "";
	const requestedRunToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("run") || "";
	const runToken = /^[\w.-]{1,100}$/.test(requestedRunToken) ? requestedRunToken : "";
	const requestedSessionId = /^[\w.-]+$/.test(qsess) && existsSync(join(cwd, ".goal-mode-pi", "sessions", qsess)) ? qsess : undefined;
	// 即使前端尚未来得及查询（例如应用启动或旧版页面），也不要重复创建未互动会话。
	const resumeSessionId = requestedSessionId || reusableEmptySession(cwd);

	// 直到用户明确进入会话才加载 pi 与监督器；首屏项目列表不为它们付冷启动成本。
	let runtime: Awaited<ReturnType<typeof loadLiveRuntime>>;
	try {
		runtime = await loadLiveRuntime();
	} catch (err) {
		ws.send(`\x1b[31m加载执行环境失败：${String(err)}\x1b[0m\r\n`);
		ws.close();
		return;
	}
	// pi 起不来（权限/依赖缺失等）→ 明确告知并关闭，让前端重连/提示，而不是留一个能聚焦却打不了字的死终端
	let exec: ReturnType<typeof runtime.spawnPiPty>;
	try {
		exec = runtime.spawnPiPty({ cwd, provider: PROVIDER, appendSystemPrompt: runtime.executorBrief(), resumeSessionId });
	} catch (err) {
		ws.send(`\x1b[31m启动 pi 失败：${String(err)}\x1b[0m\r\n`);
		ws.close();
		return;
	}
	if (runToken) activeRuns.set(runToken, { cwd, sessionId: exec.sessionId });
	const broadcastRun = (e: UIEvent) => broadcast({ ...e, runToken });

	// 【关键】先接通【输入↔pty】这条命脉——它绝不能因为下面历史/监督初始化抛错而绑不上。
	// （历史上正是：spawnPiPty 之后某步同步抛异常 → ws.on('message') 没绑上 → 终端能聚焦却打不了字）
	const rateLimitRecovery = new RateLimitRecovery({
		onWait: (delayMs, attempt, requestId) => broadcastRun({
			kind: "log",
			level: "warn",
			text: `服务限流，Pi 自带重试已用尽；${Math.ceil(delayMs / 1000)} 秒后自动从断点恢复（第 ${attempt} 次长退避${requestId ? `，${requestId}` : ""}）`,
		}),
		onRetry: () => exec.pty.write(`${RATE_LIMIT_RESUME_PROMPT}\r`),
	});
	exec.pty.onData((d) => {
		rateLimitRecovery.observeTerminal(d);
		if (ws.readyState === ws.OPEN) ws.send(d);
	});
	exec.pty.onExit(() => ws.close());
	ws.on("message", (raw) => {
		const s = raw.toString();
		if (s.startsWith("{")) {
			try {
				const m = JSON.parse(s);
				if (m.type === "resize") return void exec.pty.resize(m.cols, m.rows);
			} catch {
				/* 普通输入 */
			}
		}
		// Esc 是 Pi 原生的“停止当前生成”。终端照常收到控制字符；同时立刻撤销
		// 监督端正在进行的验收/审目标，不能等 session jsonl 异步落盘后才停止。
		if (s === "\x1b") {
			rateLimitRecovery.cancel();
			supervisor.cancelCurrent("用户按 Esc 取消");
		}
		exec.pty.write(s);
	});

	const watch = new SessionWatch(exec.sessionDir);
	const supervisor = new runtime.Supervisor({ workdir: cwd, testCmd: process.env.TEST_CMD || "", provider: PROVIDER, scopeId: exec.sessionId });
	const supervisorHistory = new SupervisorHistoryWriter(cwd, exec.sessionId);
	// live 模式的历史：一个 pi session 就是一场对话，只维护一条记录。
	const oldSession = projectHistory(cwd).entries.find((e) => e.session === exec.sessionId);
	let sessionGoal = oldSession?.goal ?? "新会话"; // 新建后立即可从历史切回；首条用户消息再替换成稳定标题
	let placeholderGoal = !oldSession;
	let sessionStatus: "●" | "✅" | "⚠" | "○" = oldSession?.status === "done" ? "✅" : oldSession?.status === "blocked" ? "⚠" : "○";
	const setSessionStatus = (status: "●" | "✅" | "⚠" | "○", note: string) => {
		sessionStatus = status;
		upsertSessionHistory(cwd, exec.sessionId, sessionGoal, status, note ? [note] : []);
		broadcast({ kind: "history-changed", cwd });
	};
	if (placeholderGoal) setSessionStatus("●", "等待输入…");
	supervisor.on("ui", (e) => {
		supervisorHistory.append(e);
		broadcastRun(e);
		// 自动回灌：把监督的重做指令真打进执行端的真实 pi（此刻 pi 刚结束一轮、处于空闲提示符，可提交新一轮）
		if (e.kind === "drive" && exec.pty) {
			exec.pty.write(`${e.text}\r`);
		}
		if (e.kind === "objective") {
			setSessionStatus(e.status === "reached" ? "✅" : "⚠", e.status === "reached" ? "监督验过，放行" : (e.reason || "监督已暂停，任务进度已保留"));
		}
	});
	void supervisor.start().catch((error) => {
		broadcastRun({ kind: "log", level: "warn", text: `监督初始化失败，执行端仍可使用：${String(error).slice(0, 180)}` });
	});

	// 历史粒度是【session】，不是 user message。所有后续追问/反馈都归入同一场对话。
	watch.on("user-task", (t) => {
		if (isSupervisorDirective(t)) return; // 自动控制消息不是用户的新任务
		rateLimitRecovery.reset();
		if (placeholderGoal) { sessionGoal = automaticSessionTitle(t) || "新会话"; placeholderGoal = false; }
		setSessionStatus("●", oldSession ? "继续对话中…" : "进行中…");
		supervisor.onUserTask(t);
	});
	watch.on("turn-end", (t) => {
		rateLimitRecovery.reset();
		supervisor.noteExecutorTurnSettled();
		void supervisor.review(t);
	});
	watch.on("turn-cancelled", (reason) => supervisor.cancelCurrent(reason));
	watch.start({ fromEnd: !!resumeSessionId });

	ws.on("close", () => {
		rateLimitRecovery.cancel();
		if (runToken) activeRuns.delete(runToken);
		if (sessionStatus === "●") setSessionStatus("○", "会话结束，这场对话尚未验完");
		watch.stop();
		supervisor.stop();
		supervisorHistory.close();
		try {
			exec.pty.kill();
		} catch {
			/* already gone */
		}
	});
});

// 启动清僵尸：上次进程若崩在半路，会留下永远"进行中"的 ● 条目。开机把它们改成 ○（没验完）。
function sweepZombies() {
	for (const e of loadProjects()) {
		const f = join(e.path, ".goal-mode-pi", "loop-log.md");
		try {
			const raw = readFileSync(f, "utf8");
			if (!raw.includes(" ●")) continue;
			const fixed = raw.replace(/^(## \S+) ●$/gm, "$1 ○").replace(/^- 进行中…$/gm, "- 上次没跑完（可能中途关了）");
			if (fixed !== raw) writeFileSync(f, fixed);
		} catch {
			/* 没日志或读不了：跳过 */
		}
	}
}

server.listen(PORT, () => {
	if (!DEMO) {
		sweepZombies();
	}
	console.log(`goal-mode-pi: http://localhost:${PORT}${DEMO ? "  (DEMO)" : ""}`);
});

// 进程级兜底：单个请求/ws 连接里漏网的同步异常不该掀翻整个 server（否则所有正在跑的 pty 会话都断连，
// 终端能聚焦却打不了字——这正是"接着聊后没法输入"的根因之一）。记录后继续存活。
process.on("uncaughtException", (err) => console.error("[uncaughtException 已兜住，server 继续存活]", err));
process.on("unhandledRejection", (err) => console.error("[unhandledRejection 已兜住]", err));

// —— 监督面板演示回放（不起 pi）——
let demoRan = false;
function runDemo() {
	if (demoRan) return;
	demoRan = true;
	const goal = "给 utils.py 增加 slugify 并让全部测试通过";
	const st = (p: number, gate: boolean, done: boolean, f: string[]) => ({
		goal,
		taskId: "demo-task",
		contractVersion: 1,
		latestRequest: goal,
		executorTurnSettled: done,
		trueIntent: "",
		reasoningAudit: {
			goal,
			userValueFunction: "最大化功能可靠性与交付速度，同时不牺牲现有调用兼容性",
			hiddenAssumptions: "slugify 的输入边界与现有调用方约定一致",
			blindSpots: "需要覆盖空字符串、Unicode 与重复分隔符",
			disconfirmingEvidence: "若现有调用依赖保留 Unicode，纯 ASCII 转换会推翻当前方案",
			alternativePaths: "可用成熟依赖替代自写，并比较依赖成本与边界正确性",
			failurePremortem: "最可能因只覆盖正常输入、遗漏真实数据边界而失败",
			recommendation: "建议先按现有接口实现最小版本并补齐边界测试，不引入额外依赖",
			verdict: "proceed" as const,
		},
		focusContract: {
			goal,
			point: "先实现 slugify 的最小正确函数并覆盖空字符串边界",
			firstPrinciple: "slugify 的核心是把一个输入字符串稳定映射为可用路径片段",
			variables: ["输入字符串", "允许字符规则"],
			calculation: "小写化 → 非允许字符替换为连字符 → 合并并裁掉首尾连字符",
			output: "确定性的 slug 字符串",
			baseline: "hello world 应输出 hello-world，空字符串应输出空字符串",
			doneWhen: "新增测试通过，且现有测试无回归",
			deferred: ["暂不增加批量处理", "暂不设计配置系统"],
			nextTrigger: "只有真实调用方提出批量需求时才扩展",
			status: "verified" as const,
			evidence: "相关新增与现有测试全部通过",
			decision: "stop" as const,
		},
		workdir: WORKDIR, testCmd: "pytest -q", plan: "", progress: p, lastTestPassed: gate,
		workRevision: 1, lastTestRevision: gate ? 1 : -1, findings: f, completed: done,
	});
	const seq: Array<[number, UIEvent]> = [
		[300, { kind: "supervisor", sub: "turn", text: `要做的：${goal.slice(0, 40)}` }],
		[500, { kind: "state", state: st(0, false, false, []) }],
		[800, { kind: "supervisor", sub: "turn", text: "看看这轮做得咋样" }],
		[1000, { kind: "supervisor", sub: "text", text: "你在自己用，我只在旁边核对事实。" }],
		[1300, { kind: "supervisor", sub: "tool", text: "git_diff" }],
		[1700, { kind: "supervisor", sub: "tool-result", text: "git_diff" }],
		[2000, { kind: "supervisor", sub: "tool", text: "run_tests" }],
		[2700, { kind: "supervisor", sub: "tool-result", text: "run_tests" }],
		[2800, { kind: "state", state: st(60, false, false, ["run_tests: 5/6，未达 100%"]) }],
		[3000, { kind: "supervisor", sub: "text", text: "6 个里过了 5 个，还差一个边界情况。" }],
		[3300, { kind: "supervisor", sub: "suggest", text: "让 pi 补一个空字符串的测试并修复。" }],
		[4200, { kind: "supervisor", sub: "turn", text: "看看这轮做得咋样" }],
		[4500, { kind: "supervisor", sub: "tool", text: "run_tests" }],
		[5200, { kind: "supervisor", sub: "tool-result", text: "run_tests" }],
		[5300, { kind: "state", state: st(100, true, true, ["run_tests: 6/6 全部通过 ✓"]) }],
		[5500, { kind: "supervisor", sub: "text", text: "都过了，可以放心。" }],
		[5700, { kind: "supervisor", sub: "tool", text: "mark_complete" }],
		[5900, { kind: "objective", status: "reached", state: st(100, true, true, ["run_tests: 6/6 全部通过 ✓"]) }],
	];
	for (const [t, e] of seq) setTimeout(() => broadcast(e), t);
}

// —— 循环模式演示回放（不起 pi）：发现→执行→验证→持久化 一轮 ——
let loopDemoRan = false;
function runLoopDemo() {
	if (loopDemoRan) return;
	loopDemoRan = true;
	const g1 = "实现 greet(name) 返回 hello, <name>";
	const g2 = "修复 parseConfig 空字符串处理";
	const q = (s1: "done" | "blocked" | "pending", s2: "done" | "blocked" | "pending") =>
		({ kind: "queue", items: [{ goal: g1, status: s1 }, { goal: g2, status: s2 }] }) as LoopEvent;
	const seq: Array<[number, LoopEvent]> = [
		[200, { kind: "loop", sub: "discover-start" }],
		[1200, { kind: "loop", sub: "discovered", added: 2, pending: 2 }],
		[1300, q("pending", "pending")],
		[1600, { kind: "term-reset" }],
		[1700, { kind: "loop", sub: "goal-start", goal: g1, index: 1, total: 2 }],
		[1900, { kind: "term", data: "\x1b[90m$ pi 正在实现 greet…\x1b[0m\r\n" }],
		[2200, { kind: "term", data: "编辑 src/app.js，写入 greet 实现。\r\n" }],
		[2600, { kind: "supervisor", sub: "turn", text: "看看这轮做得咋样" }],
		[2900, { kind: "supervisor", sub: "tool", text: "git_diff" }],
		[3200, { kind: "supervisor", sub: "tool-result", text: "git_diff" }],
		[3500, { kind: "supervisor", sub: "text", text: "改得对，greet 没问题。" }],
		[3700, { kind: "supervisor", sub: "tool", text: "mark_complete" }],
		[3900, { kind: "loop", sub: "goal-done", goal: g1, status: "done" }],
		[4000, q("done", "pending")],
		[4300, { kind: "term-reset" }],
		[4400, { kind: "loop", sub: "goal-start", goal: g2, index: 2, total: 2 }],
		[4700, { kind: "term", data: "\x1b[90m$ pi 正在修复 parseConfig…\x1b[0m\r\n" }],
		[5200, { kind: "supervisor", sub: "turn", text: "看看这轮做得咋样" }],
		[5500, { kind: "supervisor", sub: "tool", text: "run_tests" }],
		[5900, { kind: "supervisor", sub: "tool-result", text: "run_tests" }],
		[6100, { kind: "supervisor", sub: "text", text: "空字符串会返回 {} 了，修好了。" }],
		[6300, { kind: "supervisor", sub: "tool", text: "mark_complete" }],
		[6500, { kind: "loop", sub: "goal-done", goal: g2, status: "done" }],
		[6600, q("done", "done")],
		[6800, { kind: "loop", sub: "round-done", done: 2, blocked: 0, paused: 0 }],
	];
	for (const [t, e] of seq) setTimeout(() => broadcast(e), t);
}
