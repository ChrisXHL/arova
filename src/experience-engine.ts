import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TaskLedger } from "./task-ledger.ts";

export type ExperienceLevel = "candidate" | "project" | "domain" | "deprecated";
export type ExperienceOutcome = "supported" | "refuted" | "not_applicable";

export interface ExperienceVersion {
	version: number;
	trigger: string;
	action: string;
	boundary: string;
	evidence: string;
	createdAt: string;
	reason: string;
}

export interface ExperienceCard {
	id: string;
	level: ExperienceLevel;
	tags: string[];
	versions: ExperienceVersion[];
	supportTaskIds: string[];
	supportProjectKeys: string[];
	refutations: Array<{ taskId: string; evidence: string; at: string }>;
	confidence: number;
	lastValidatedAt: string;
	lastUsedAt: string;
	expiresAt?: string;
}

export interface ExperienceEvent {
	at: string;
	type: "proposed" | "outcome" | "promoted" | "deprecated" | "retrieved";
	cardId: string;
	taskId?: string;
	details: string;
}

const dirs = (workdir: string) => ({ root: join(workdir, ".goal-mode-pi", "experience"), cards: join(workdir, ".goal-mode-pi", "experience", "cards.json"), events: join(workdir, ".goal-mode-pi", "experience", "events.jsonl") });
const now = () => new Date().toISOString();
const norm = (s: string) => s.trim().replace(/\s+/g, " ");
const projectKey = (workdir: string) => basename(workdir);

export function loadExperienceCards(workdir: string): ExperienceCard[] {
	try { return JSON.parse(readFileSync(dirs(workdir).cards, "utf8")) as ExperienceCard[]; } catch { return []; }
}
function writeCards(workdir: string, cards: ExperienceCard[]): void {
	const d = dirs(workdir); mkdirSync(d.root, { recursive: true }); const temp = `${d.cards}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(cards, null, 2)); renameSync(temp, d.cards);
}
function event(workdir: string, value: ExperienceEvent): void {
	const d = dirs(workdir); mkdirSync(d.root, { recursive: true }); appendFileSync(d.events, `${JSON.stringify(value)}\n`);
}
function tagsFor(...texts: string[]): string[] {
	return [...new Set(texts.join(" ").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 20);
}
function current(card: ExperienceCard): ExperienceVersion { return card.versions[card.versions.length - 1]; }
function expired(card: ExperienceCard): boolean { return !!card.expiresAt && Date.parse(card.expiresAt) < Date.now(); }

export function proposeExperience(workdir: string, input: { id: string; taskId: string; trigger: string; action: string; boundary: string; evidence: string; tags?: string[]; expiresAt?: string }): ExperienceCard {
	const id = norm(input.id).toLowerCase().replace(/[^\w.-]+/g, "-");
	if (!id || norm(input.trigger).length < 8 || norm(input.action).length < 8 || norm(input.boundary).length < 8 || norm(input.evidence).length < 12) throw new Error("经验卡需要具体的触发条件、动作、边界和证据。");
	const cards = loadExperienceCards(workdir);
	if (cards.some((card) => card.id === id)) throw new Error("经验卡 id 已存在；用记录结果或版本更新，而不是重复提议。");
	const at = now();
	const card: ExperienceCard = { id, level: "candidate", tags: [...new Set([...(input.tags ?? []).map(norm).filter(Boolean), ...tagsFor(input.trigger, input.action)])], versions: [{ version: 1, trigger: norm(input.trigger), action: norm(input.action), boundary: norm(input.boundary), evidence: norm(input.evidence), createdAt: at, reason: "任务证据提炼出的候选经验" }], supportTaskIds: [input.taskId], supportProjectKeys: [projectKey(workdir)], refutations: [], confidence: 0.35, lastValidatedAt: at, lastUsedAt: "", ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
	cards.push(card); writeCards(workdir, cards); event(workdir, { at, type: "proposed", cardId: id, taskId: input.taskId, details: card.versions[0].evidence }); return card;
}

/** 任务闭环后把已成功的行动变成低置信候选，绝不直接晋升长期规则。 */
export function deriveExperienceCandidate(workdir: string, taskId: string, goal: string, ledger: TaskLedger): ExperienceCard | undefined {
	const success = [...ledger.attempts].reverse().find((attempt) => attempt.outcome === "success");
	if (!success) return undefined;
	const id = `task-${taskId}-successful-path`.toLowerCase().replace(/[^\w.-]+/g, "-");
	if (loadExperienceCards(workdir).some((card) => card.id === id)) return undefined;
	const proof = ledger.requirements.filter((item) => item.evidence).map((item) => `${item.id}: ${item.evidence}`).join("；");
	try {
		return proposeExperience(workdir, { id, taskId, trigger: `遇到与“${norm(goal).slice(0, 120)}”相似、且前提一致的任务`, action: success.action, boundary: "仅作为候选路径；必须重新核实当前任务前提、工具状态与证据，不能把一次成功当通用结论。", evidence: `${success.learned}；${proof}`.slice(0, 2000), tags: tagsFor(goal, success.action) });
	} catch { return undefined; }
}

export function recordExperienceOutcome(workdir: string, input: { id: string; taskId: string; outcome: ExperienceOutcome; evidence: string; triggerMatched: boolean }): ExperienceCard {
	const cards = loadExperienceCards(workdir); const card = cards.find((item) => item.id === input.id); if (!card) throw new Error("经验卡不存在。");
	if (norm(input.evidence).length < 12) throw new Error("经验更新必须附具体证据。");
	const at = now();
	if (input.outcome === "supported") {
		if (!card.supportTaskIds.includes(input.taskId)) card.supportTaskIds.push(input.taskId);
		if (!card.supportProjectKeys.includes(projectKey(workdir))) card.supportProjectKeys.push(projectKey(workdir));
		card.confidence = Math.min(0.95, card.confidence + 0.2); card.lastValidatedAt = at;
	} else if (input.outcome === "refuted" && input.triggerMatched) {
		card.refutations.push({ taskId: input.taskId, evidence: norm(input.evidence), at }); card.confidence = Math.max(0, card.confidence - 0.35); card.lastValidatedAt = at;
	} else {
		card.confidence = Math.max(0.05, card.confidence - 0.05);
	}
	if (card.refutations.length >= 2 || card.confidence < 0.15) card.level = "deprecated";
	writeCards(workdir, cards); event(workdir, { at, type: card.level === "deprecated" ? "deprecated" : "outcome", cardId: card.id, taskId: input.taskId, details: `${input.outcome}: ${norm(input.evidence)}` }); return card;
}

export function reviseExperience(workdir: string, input: { id: string; trigger: string; action: string; boundary: string; evidence: string; reason: string }): ExperienceCard {
	const cards = loadExperienceCards(workdir); const card = cards.find((item) => item.id === input.id); if (!card) throw new Error("经验卡不存在。");
	const previous = current(card); const at = now();
	card.versions.push({ version: previous.version + 1, trigger: norm(input.trigger), action: norm(input.action), boundary: norm(input.boundary), evidence: norm(input.evidence), createdAt: at, reason: norm(input.reason) }); card.tags = [...new Set([...card.tags, ...tagsFor(input.trigger, input.action)])]; card.lastValidatedAt = at;
	writeCards(workdir, cards); event(workdir, { at, type: "outcome", cardId: card.id, details: `版本更新：${norm(input.reason)}` }); return card;
}

export function promoteExperience(workdir: string, id: string): ExperienceCard {
	const cards = loadExperienceCards(workdir); const card = cards.find((item) => item.id === id); if (!card) throw new Error("经验卡不存在。");
	if (card.level === "deprecated") throw new Error("已废弃经验不能晋升。");
	const next: ExperienceLevel = card.supportProjectKeys.length >= 3 ? "domain" : card.supportTaskIds.length >= 2 ? "project" : "candidate";
	if (next === "candidate") throw new Error("至少需要两个独立任务验证后才能晋升项目经验。");
	card.level = next; card.confidence = Math.max(card.confidence, next === "domain" ? 0.8 : 0.6); writeCards(workdir, cards); event(workdir, { at: now(), type: "promoted", cardId: card.id, details: `晋升为 ${next}` }); return card;
}

export function retrieveExperiencePack(workdir: string, query: string, limit = 5): ExperienceCard[] {
	const queryTags = new Set(tagsFor(query)); const cards = loadExperienceCards(workdir);
	const selected = cards.filter((card) => card.level !== "candidate" && card.level !== "deprecated" && !expired(card)).map((card) => ({ card, score: card.confidence * 3 + card.tags.filter((tag) => queryTags.has(tag)).length * 2 + (card.level === "domain" ? 1 : 0) })).filter((entry) => entry.score > entry.card.confidence * 3).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 5))).map((entry) => entry.card);
	const at = now(); for (const card of selected) card.lastUsedAt = at; if (selected.length) { writeCards(workdir, cards); for (const card of selected) event(workdir, { at, type: "retrieved", cardId: card.id, details: `query=${norm(query).slice(0, 200)}` }); }
	return selected;
}

export function experiencePackText(cards: ExperienceCard[]): string {
	if (!cards.length) return "（没有已晋升且匹配当前任务的经验；从当前证据出发，不要凭空套用旧套路。）";
	return cards.map((card) => { const v = current(card); return `- [${card.level} / 置信度 ${card.confidence.toFixed(2)}] ${card.id}\n  触发：${v.trigger}\n  建议动作：${v.action}\n  边界：${v.boundary}\n  证据：${v.evidence}\n  反例数：${card.refutations.length}`; }).join("\n");
}

export function experienceStoreExists(workdir: string): boolean { return existsSync(dirs(workdir).cards); }
