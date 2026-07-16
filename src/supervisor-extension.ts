import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type GoalModeState, saveState } from "./state.ts";
import { appendSupervisorMemory, appendUserMemory } from "./supervisor-memory.ts";
import { loadProgressivePlan, needsWorkBreakdown, progressivePlanBrief, saveProgressivePlan, validateWorkPlan, verifyProgressiveWorkItem, type WorkItem } from "./progressive-plan.ts";
import { goalLedgerBrief, loadGoalLedger, needsGoalLedger, saveGoalLedger, validateGoalLedger, verifyLedgerItem, type GoalLedgerItem } from "./goal-ledger.ts";
import { loadTaskContract, taskContractText } from "./task-contract.ts";
import { coverage, isCurrentResearchLedger, isTextFetchBlocked, loadResearchLedger, researchCompletionProblem, saveResearchLedger, validateResearchFields, type ResearchAccess, type ResearchSourceKind } from "./research-ledger.ts";
import { isCurrentTaskLedger, loadTaskLedger, saveTaskLedger, taskCompletionProblem, validateRequirements, type AttemptOutcome, type BlockerKind, type EvidenceKind, type GapStatus } from "./task-ledger.ts";
import { deriveExperienceCandidate, experiencePackText, promoteExperience, proposeExperience, recordExperienceOutcome, retrieveExperiencePack, reviseExperience, type ExperienceOutcome } from "./experience-engine.ts";
import { freezeProblem, implementationProblem, isProductBuildTask, loadProductRequirements, saveProductRequirements, validateProductRequirements, type ProductRequirement } from "./product-requirement-ledger.ts";

/** inject_directive 的去向：GUI 旁挂 = 在面板里给建议；CLI = 直接驱动 executor。 */
export type SuggestFn = (message: string, urgent: boolean) => void;

/** Exa key：env 优先，否则读 ~/.goal-mode-pi/config.json。有则 web_search 走语义搜索，无则 Bing 兜底。 */
function exaKey(): string {
	if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY;
	try {
		return JSON.parse(readFileSync(join(homedir(), ".goal-mode-pi", "config.json"), "utf8")).exaApiKey || "";
	} catch {
		return "";
	}
}

/** testCmd 为空时按项目类型探测一条测试命令。 */
function detectTestCmd(dir: string): string {
	const has = (f: string) => existsSync(join(dir, f));
	if (has("package.json")) return "npm test";
	if (has("pyproject.toml") || has("pytest.ini") || has("tests") || has("setup.py")) return "pytest -q";
	if (has("Cargo.toml")) return "cargo test";
	if (has("go.mod")) return "go test ./...";
	if (has("Makefile")) return "make test";
	return "";
}

/**
 * 把监督逻辑做成「真工具」，而不是把规则写进 prompt。
 *
 * 监督端不直接驱动执行端（执行端是用户亲自操作的原生 pi）。
 * inject_directive 通过 onSuggest 回调把建议交出去：GUI 在右侧面板显示，CLI 才真正驱动。
 *
 * 关键设计：mark_complete 在工具内部强制校验 state.lastTestPassed，
 * 模型无法靠"说我做完了"绕过 —— 事实门写进了工具语义。
 */
export function createSupervisorExtension(state: GoalModeState, onSuggest: SuggestFn, isCurrent: () => boolean = () => true) {
	return function supervisorExtension(pi: ExtensionAPI): void {
		const sh = (cmd: string) =>
			execFileSync("bash", ["-lc", cmd], { cwd: state.workdir, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

		const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });
		const stale = () => text("当前监督轮已被用户的新输入取代；本次工具结果已丢弃，不能修改新任务状态。");

		const UA =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
		const curl = (url: string) =>
			execFileSync("curl", ["-sL", "-A", UA, "--max-time", "25", url], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
		const stripHtml = (h: string) =>
			h
				.replace(/<script[\s\S]*?<\/script>/gi, "")
				.replace(/<style[\s\S]*?<\/style>/gi, "")
				.replace(/<[^>]+>/g, " ")
				.replace(/&nbsp;/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&#?\w+;/g, "")
				.replace(/[ \t]+/g, " ")
				.replace(/\n\s*\n\s*\n+/g, "\n\n")
				.trim();

		// —— 上网：监督去【活的互联网】找标杆、核一手事实（无 key，直连搜索引擎）——

		pi.registerTool({
			name: "web_search",
			label: "Web Search",
			description:
				"上网搜索：核实一手事实、或找【当下的标杆/最佳实践/顶级范例】来对标执行端的产出。有 Exa 时是语义搜索（直出一手来源+正文），否则 Bing 兜底。再用 web_fetch/agent-reach read 打开细看。",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (_id, p) => {
				const key = exaKey();
				if (key) {
					try {
						const body = JSON.stringify({
							query: p.query,
							numResults: 6,
							contents: { text: { maxCharacters: 800 } },
						});
						const out = execFileSync(
							"curl",
							["-s", "https://api.exa.ai/search", "-H", `x-api-key: ${key}`, "-H", "Content-Type: application/json", "-d", body, "--max-time", "25"],
							{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
						);
						const d = JSON.parse(out) as { results?: Array<{ title?: string; url?: string; text?: string }> };
						if (d.results?.length) {
							const md = d.results
								.map((r, i) => `${i + 1}. ${r.title ?? ""}\n   ${r.url ?? ""}\n   ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 500)}`)
								.join("\n\n");
							return text(`【Exa 语义搜索】${p.query}\n\n${md}`);
						}
					} catch {
						/* 落到 Bing 兜底 */
					}
				}
				try {
					const html = curl(`https://www.bing.com/search?q=${encodeURIComponent(p.query)}&setlang=zh-CN`);
					const urls = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)]
						.map((m) => m[0].replace(/&amp;.*$/, ""))
						.filter((u) => !/bing\.(com|net)|microsoft|msn\.|live\.com|w3\.org|schema\.org|\/th\/id\/|\.(css|js|png|jpg|gif|svg|ico)(\?|$)/i.test(u))
						.filter((u, i, a) => a.indexOf(u) === i)
						.slice(0, 12);
					return text(`【Bing 搜索】${p.query}\n\n${stripHtml(html).slice(0, 3500)}\n\n候选链接:\n${urls.join("\n")}`);
				} catch (e) {
					return text(`搜索失败：${String(e).slice(0, 160)}`);
				}
			},
		});

		pi.registerTool({
			name: "web_fetch",
			label: "Web Fetch",
			description: "打开一个网址，返回正文文本（用来核实一手来源、读标杆范例）。",
			parameters: Type.Object({ url: Type.String() }),
			execute: async (_id, p) => {
				try {
					const raw = curl(p.url);
					const body = stripHtml(raw);
					const blocked = isTextFetchBlocked(body);
					return text(blocked
						? `【${p.url}】\n文本抓取被站点安全策略拦截；这不代表资料未公开。必须改用已登录浏览器读取页面、目录、附件和站内搜索结果，并把实际访问的 URL 记入研究证据账本。\n\n${body.slice(0, 1200)}`
						: `【${p.url}】\n${body.slice(0, 6000)}`);
				} catch (e) {
					return text(`抓取失败：${String(e).slice(0, 160)}`);
				}
			},
		});

		// —— 研究证据账本：把“多翻几页、多源核对”变成可验收状态，不靠模型自觉 ——
		pi.registerTool({
			name: "set_task_ledger",
			label: "Set Task Ledger",
			description: "为任何任务建立持久化事实账本：把最终要证明的要求拆开；之后记录事实、假设、缺口、尝试路径与完成证据。不是固定流程，遇到新证据可以调整，但没有证据不能宣布完成。",
			parameters: Type.Object({ requirements: Type.Array(Type.Object({ id: Type.String(), description: Type.String() }), { minItems: 1 }), next_action: Type.String(), preserve_verified_context: Type.Optional(Type.Boolean()) }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const requirements = (params.requirements ?? []).map((item) => ({ id: item.id.trim(), description: item.description.trim() }));
				const error = validateRequirements(requirements);
				if (error) return text(`拒绝：${error}`);
				const previous = loadTaskLedger(state.workdir, state.scopeId);
				const carry = params.preserve_verified_context === true && previous.taskId === state.taskId;
				const evidenceById = new Map(previous.requirements.map((item) => [item.id, item.evidence]));
				saveTaskLedger(state.workdir, { taskId: state.taskId, contractVersion: state.contractVersion, goal: state.goal, requirements: requirements.map((item) => ({ ...item, evidence: carry ? evidenceById.get(item.id) ?? "" : "" })), facts: carry ? previous.facts : [], hypotheses: carry ? previous.hypotheses : [], gaps: carry ? previous.gaps : [], attempts: carry ? previous.attempts : [], nextAction: params.next_action.trim() }, state.scopeId);
				return text(`task ledger 已建立：${requirements.map((item) => item.id).join("、")}。每次失败必须记录原因和不同的下一条路径，不能原地重复。`);
			},
		});

		// —— 产品需求冻结：产品假设没有证据、反证、指标、验收和非目标项，禁止进入编码 ——
		pi.registerTool({
			name: "set_product_requirement_ledger",
			label: "Set Product Requirement Ledger",
			description: "建立可验证的产品需求。每项必须写用户问题、假设、支持证据、反证、成功指标、验收标准和非目标项；这不是 PRD 文案，而是编码前的事实合同。",
			parameters: Type.Object({ requirements: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), user_problem: Type.String(), hypothesis: Type.String(), evidence: Type.String(), counter_evidence: Type.String(), metric: Type.String(), acceptance: Type.String(), non_goal: Type.String() }), { minItems: 1 }) }),
			execute: async (_id, params) => {
				const requirements: ProductRequirement[] = (params.requirements ?? []).map((item) => ({ id: item.id.trim(), title: item.title.trim(), userProblem: item.user_problem.trim(), hypothesis: item.hypothesis.trim(), evidence: item.evidence.trim(), counterEvidence: item.counter_evidence.trim(), metric: item.metric.trim(), acceptance: item.acceptance.trim(), nonGoal: item.non_goal.trim() }));
				const error = validateProductRequirements(requirements); if (error) return text(`拒绝：${error}`);
				saveProductRequirements(state.workdir, { taskId: state.taskId, contractVersion: state.contractVersion, goal: state.goal, requirements, frozen: false, frozenAt: "", freezeReason: "", implementations: [] }, state.scopeId);
				return text(`产品需求账本已建立：${requirements.map((item) => item.id).join("、")}。现在必须由监督端核对证据与反证，再冻结；冻结前不能写代码。`);
			},
		});
		pi.registerTool({
			name: "freeze_product_requirements",
			label: "Freeze Product Requirements",
			description: "在确认每项需求都拥有证据、反证、指标、验收与非目标项后冻结需求合同；需求变更必须新版本重建。",
			parameters: Type.Object({ reason: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadProductRequirements(state.workdir, state.scopeId); const problem = freezeProblem(ledger, state.taskId, state.contractVersion);
				if (problem && !problem.includes("尚未冻结")) return text(`拒绝：${problem}`);
				if (params.reason.trim().length < 20) return text("拒绝：冻结理由必须说明核查过哪些证据、反证和范围边界。");
				ledger.frozen = true; ledger.frozenAt = new Date().toISOString(); ledger.freezeReason = params.reason.trim(); saveProductRequirements(state.workdir, ledger, state.scopeId);
				return text("产品需求已冻结；现在可以把需求 ID 映射到代码工作项。后续实质变更会要求建立新版本。");
			},
		});
		pi.registerTool({
			name: "link_requirement_implementation",
			label: "Link Requirement Implementation",
			description: "把已冻结需求关联到实际代码和测试证据。没有测试证据的功能不算实现了需求。",
			parameters: Type.Object({ requirement_id: Type.String(), code_evidence: Type.String(), test_evidence: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadProductRequirements(state.workdir, state.scopeId); const problem = freezeProblem(ledger, state.taskId, state.contractVersion); if (problem) return text(`拒绝：${problem}`);
				if (!ledger.requirements.some((item) => item.id === params.requirement_id.trim())) return text("拒绝：requirement_id 不在已冻结需求中。");
				if (params.code_evidence.trim().length < 12 || params.test_evidence.trim().length < 12) return text("拒绝：代码和测试证据都必须可复查。");
				ledger.implementations = ledger.implementations.filter((item) => item.requirementId !== params.requirement_id.trim()); ledger.implementations.push({ requirementId: params.requirement_id.trim(), codeEvidence: params.code_evidence.trim(), testEvidence: params.test_evidence.trim() }); saveProductRequirements(state.workdir, ledger, state.scopeId);
				return text(`需求 ${params.requirement_id} 已建立代码与测试追溯。`);
			},
		});

		// —— 经验引擎：事件、候选、晋升和反例分层，禁止把一次成功当长期真理 ——
		pi.registerTool({
			name: "propose_experience",
			label: "Propose Experience",
			description: "基于当前任务已验证证据提出候选经验。它不会自动变成长期规则；必须写触发条件、动作、边界与证据，之后由独立任务结果晋升或淘汰。",
			parameters: Type.Object({ id: Type.String(), trigger: Type.String(), action: Type.String(), boundary: Type.String(), evidence: Type.String(), tags: Type.Optional(Type.Array(Type.String())), expires_at: Type.Optional(Type.String()) }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				try { const card = proposeExperience(state.workdir, { id: params.id, taskId: state.taskId, trigger: params.trigger, action: params.action, boundary: params.boundary, evidence: params.evidence, tags: params.tags, expiresAt: params.expires_at }); return text(`候选经验已记录：${card.id}。它还不是长期规则，需独立任务验证。`); } catch (error) { return text(`拒绝：${String(error)}`); }
			},
		});
		pi.registerTool({
			name: "record_experience_outcome",
			label: "Record Experience Outcome",
			description: "记录一条经验在新任务中的实际结果。相同触发条件下的反例会降低置信度；条件不同只能补边界，不能错误推翻原经验。",
			parameters: Type.Object({ id: Type.String(), outcome: Type.Union([Type.Literal("supported"), Type.Literal("refuted"), Type.Literal("not_applicable")]), evidence: Type.String(), trigger_matched: Type.Boolean() }),
			execute: async (_id, params) => {
				try { const card = recordExperienceOutcome(state.workdir, { id: params.id, taskId: state.taskId, outcome: params.outcome as ExperienceOutcome, evidence: params.evidence, triggerMatched: params.trigger_matched }); return text(`经验 ${card.id} 已更新：${card.level}，置信度 ${card.confidence.toFixed(2)}。`); } catch (error) { return text(`拒绝：${String(error)}`); }
			},
		});
		pi.registerTool({
			name: "revise_experience",
			label: "Revise Experience",
			description: "以新版本修订经验的动作或边界，保留旧版本与原因；禁止静默覆盖旧经验。",
			parameters: Type.Object({ id: Type.String(), trigger: Type.String(), action: Type.String(), boundary: Type.String(), evidence: Type.String(), reason: Type.String() }),
			execute: async (_id, params) => {
				try { const card = reviseExperience(state.workdir, params); return text(`经验 ${card.id} 已创建 v${card.versions.length}，旧版本及证据仍保留。`); } catch (error) { return text(`拒绝：${String(error)}`); }
			},
		});
		pi.registerTool({
			name: "promote_experience",
			label: "Promote Experience",
			description: "按独立任务/项目验证次数晋升候选经验。两次独立任务可晋升 project，三个项目可晋升 domain；禁止凭感觉晋升。",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, params) => {
				try { const card = promoteExperience(state.workdir, params.id); return text(`经验 ${card.id} 已晋升为 ${card.level}。`); } catch (error) { return text(`拒绝：${String(error)}`); }
			},
		});
		pi.registerTool({
			name: "inspect_experience_pack",
			label: "Inspect Experience Pack",
			description: "按当前问题检索最多五条已晋升经验，连同边界和反例一起返回；经验只提供先验，不替代本轮证据。",
			parameters: Type.Object({ query: Type.String() }),
			execute: async (_id, params) => text(experiencePackText(retrieveExperiencePack(state.workdir, params.query))),
		});

		pi.registerTool({
			name: "record_task_fact",
			label: "Record Task Fact",
			description: "记录一个已经被工具、文件、浏览器、URL、用户或运行结果证实的事实。推测不要记成事实，应使用 record_task_hypothesis。",
			parameters: Type.Object({ id: Type.String(), claim: Type.String(), evidence: Type.String(), kind: Type.Union([Type.Literal("tool"), Type.Literal("file"), Type.Literal("url"), Type.Literal("browser"), Type.Literal("user"), Type.Literal("runtime")]) }),
			execute: async (_id, params) => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				if (!isCurrentTaskLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立 task ledger。");
				if (params.claim.trim().length < 8 || params.evidence.trim().length < 8) return text("拒绝：事实和证据都必须具体，不能写“已完成”。");
				ledger.facts = ledger.facts.filter((item) => item.id !== params.id.trim());
				ledger.facts.push({ id: params.id.trim(), claim: params.claim.trim(), evidence: params.evidence.trim(), kind: params.kind as EvidenceKind });
				saveTaskLedger(state.workdir, ledger, state.scopeId); return text(`已记录事实：${params.id}`);
			},
		});

		pi.registerTool({
			name: "record_task_hypothesis",
			label: "Record Task Hypothesis",
			description: "把尚未确定的判断显式写为假设；验证或否定后更新状态，避免模型把合理猜测写成事实。",
			parameters: Type.Object({ id: Type.String(), statement: Type.String(), status: Type.Union([Type.Literal("open"), Type.Literal("validated"), Type.Literal("rejected")]), evidence: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				if (!isCurrentTaskLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立 task ledger。");
				if (params.status !== "open" && params.evidence.trim().length < 8) return text("拒绝：验证或否定假设时必须附证据。");
				ledger.hypotheses = ledger.hypotheses.filter((item) => item.id !== params.id.trim());
				ledger.hypotheses.push({ id: params.id.trim(), statement: params.statement.trim(), status: params.status, evidence: params.evidence.trim() });
				saveTaskLedger(state.workdir, ledger, state.scopeId); return text(`假设 ${params.id} = ${params.status}`);
			},
		});

		pi.registerTool({
			name: "record_task_gap",
			label: "Record Task Gap",
			description: "记录尚未解开的关键问题；critical 缺口不能带着完成。出现新事实后可标记 resolved，真正无法验证才标记 blocked 并写清边界。",
			parameters: Type.Object({ id: Type.String(), question: Type.String(), critical: Type.Boolean(), status: Type.Union([Type.Literal("open"), Type.Literal("resolved"), Type.Literal("blocked")]), resolution: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				if (!isCurrentTaskLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立 task ledger。");
				if (params.status !== "open" && params.resolution.trim().length < 8) return text("拒绝：关闭缺口必须写明解决证据或不可验证边界。");
				ledger.gaps = ledger.gaps.filter((item) => item.id !== params.id.trim());
				ledger.gaps.push({ id: params.id.trim(), question: params.question.trim(), critical: params.critical, status: params.status as GapStatus, resolution: params.resolution.trim() });
				saveTaskLedger(state.workdir, ledger, state.scopeId); return text(`缺口 ${params.id} = ${params.status}`);
			},
		});

		pi.registerTool({
			name: "record_task_attempt",
			label: "Record Task Attempt",
			description: "记录一次行动的结果。failed/blocked/no_new_evidence 必须写学到了什么及下一条不同路径，系统借此避免无效重试。",
			parameters: Type.Object({ action: Type.String(), outcome: Type.Union([Type.Literal("success"), Type.Literal("no_new_evidence"), Type.Literal("blocked"), Type.Literal("failed")]), blocker: Type.Union([Type.Literal("none"), Type.Literal("access"), Type.Literal("missing_data"), Type.Literal("tool_failure"), Type.Literal("conflict"), Type.Literal("unknown")]), learned: Type.String(), next_action: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				if (!isCurrentTaskLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立 task ledger。");
				if (params.learned.trim().length < 8 || params.next_action.trim().length < 8) return text("拒绝：每次尝试都要写实际学到的东西和下一步行动。");
				if (params.outcome !== "success" && /^(重试|再试一次|继续尝试)$/i.test(params.next_action.trim())) return text("拒绝：失败后不能只写原地重试；要换信息源、工具、路径或明确停止边界。");
				ledger.attempts.push({ action: params.action.trim(), outcome: params.outcome as AttemptOutcome, blocker: params.blocker as BlockerKind, learned: params.learned.trim(), nextAction: params.next_action.trim(), at: new Date().toISOString() }); ledger.nextAction = params.next_action.trim();
				saveTaskLedger(state.workdir, ledger, state.scopeId); return text(`已记录尝试：${params.outcome}；下一步：${ledger.nextAction}`);
			},
		});

		pi.registerTool({
			name: "verify_task_requirement",
			label: "Verify Task Requirement",
			description: "为一个 task ledger 要求写入完成证据。只有所有要求都有具体证据、关键缺口关闭且假设不悬空时才能完成。",
			parameters: Type.Object({ id: Type.String(), evidence: Type.String() }),
			execute: async (_id, params) => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				if (!isCurrentTaskLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立 task ledger。");
				const item = ledger.requirements.find((requirement) => requirement.id === params.id.trim());
				if (!item) return text("拒绝：该 requirement id 不存在。");
				if (params.evidence.trim().length < 12) return text("拒绝：完成证据太短，写清文件、工具输出、外部反馈或可复现结果。");
				item.evidence = params.evidence.trim(); saveTaskLedger(state.workdir, ledger, state.scopeId); return text(`要求 ${item.id} 已记录完成证据。`);
			},
		});

		pi.registerTool({
			name: "inspect_task_ledger",
			label: "Inspect Task Ledger",
			description: "查看当前任务的事实、假设、缺口、尝试路径和仍不可完成的原因；每次卡住或交付前使用。",
			parameters: Type.Object({}),
			execute: async () => {
				const ledger = loadTaskLedger(state.workdir, state.scopeId);
				return text(`${JSON.stringify(ledger, null, 2)}\n\n${taskCompletionProblem(ledger, state.taskId, state.contractVersion) ?? "账本满足完成门。"}`);
			},
		});

		pi.registerTool({
			name: "set_research_contract",
			label: "Set Research Contract",
			description: "研究开始前定义字段清单与官方域名。字段是采集完成度的唯一口径；critical 字段必须有官方来源和两个独立来源一致才可完成。",
			parameters: Type.Object({
				official_domains: Type.Array(Type.String(), { minItems: 1 }),
				fields: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), critical: Type.Boolean() }), { minItems: 1 }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const fields = (params.fields ?? []).map((field) => ({ id: field.id.trim(), label: field.label.trim(), critical: field.critical }));
				const error = validateResearchFields(fields);
				if (error) return text(`拒绝：${error}`);
				const officialDomains = [...new Set((params.official_domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
				if (!officialDomains.length) return text("拒绝：至少提供一个官方域名。");
				saveResearchLedger(state.workdir, { taskId: state.taskId, contractVersion: state.contractVersion, goal: state.goal, officialDomains, fields, visits: [], evidence: [] }, state.scopeId);
				return text(`研究合同已建立：${fields.map((field) => field.id).join("、")}。先深挖 ${officialDomains.join("、")}；文本抓取受限时改用已登录浏览器，并记录每个尝试入口。`);
			},
		});

		pi.registerTool({
			name: "record_research_visit",
			label: "Record Research Visit",
			description: "记录一页官方资料、附件、站内搜索或官方 AI 助手的真实访问结果。blocked 只表示当前通道受限，绝不能当作未公开。",
			parameters: Type.Object({
				url: Type.String(), source_kind: Type.Union([Type.Literal("official_page"), Type.Literal("official_attachment"), Type.Literal("official_ai"), Type.Literal("official_api"), Type.Literal("independent"), Type.Literal("community")]),
				access: Type.Union([Type.Literal("read"), Type.Literal("blocked"), Type.Literal("no_new_data"), Type.Literal("not_relevant")]), note: Type.String(),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const ledger = loadResearchLedger(state.workdir, state.scopeId);
				if (!isCurrentResearchLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立研究合同。");
				ledger.visits.push({ url: params.url.trim(), sourceKind: params.source_kind as ResearchSourceKind, access: params.access as ResearchAccess, note: params.note.trim(), visitedAt: new Date().toISOString() });
				saveResearchLedger(state.workdir, ledger, state.scopeId);
				return text(`已记录访问：${params.access} ${params.url}`);
			},
		});

		pi.registerTool({
			name: "record_research_evidence",
			label: "Record Research Evidence",
			description: "把一个实际读到的字段值连同 URL、来源类别和独立来源键写入账本。多个转载若来自同一公告，independent_key 必须相同，不能伪装成交叉验证。",
			parameters: Type.Object({
				field_id: Type.String(), value: Type.String(), url: Type.String(), source_kind: Type.Union([Type.Literal("official_page"), Type.Literal("official_attachment"), Type.Literal("official_ai"), Type.Literal("official_api"), Type.Literal("independent"), Type.Literal("community")]), independent_key: Type.String(), note: Type.String(),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const ledger = loadResearchLedger(state.workdir, state.scopeId);
				if (!isCurrentResearchLedger(ledger, state.taskId, state.contractVersion)) return text("拒绝：先建立研究合同。");
				if (!ledger.fields.some((field) => field.id === params.field_id.trim())) return text("拒绝：field_id 不在研究合同中。");
				if (params.source_kind === "official_ai" && !params.note.trim()) return text("拒绝：官方 AI 回答必须写明它指向的页面、文档或仍待验证的缺口。");
				ledger.evidence.push({ fieldId: params.field_id.trim(), value: params.value.trim(), url: params.url.trim(), sourceKind: params.source_kind as ResearchSourceKind, independentKey: params.independent_key.trim(), observedAt: new Date().toISOString(), note: params.note.trim() });
				saveResearchLedger(state.workdir, ledger, state.scopeId);
				return text(`已记录证据。当前覆盖：${coverage(ledger).map((row) => `${row.field.id}:${row.state}`).join("、")}`);
			},
		});

		pi.registerTool({
			name: "assess_research_coverage",
			label: "Assess Research Coverage",
			description: "输出字段覆盖度、冲突和仍需补的独立来源；交付研究结论前必须调用。",
			parameters: Type.Object({}),
			execute: async () => {
				const ledger = loadResearchLedger(state.workdir, state.scopeId);
				if (!isCurrentResearchLedger(ledger, state.taskId, state.contractVersion)) return text("尚未建立当前研究合同。");
				const rows = coverage(ledger);
				return text(`访问 ${ledger.visits.length} 个入口，记录 ${ledger.evidence.length} 条证据。\n${rows.map((row) => `${row.field.id}（${row.field.label}）：${row.state}${row.values.length ? ` = ${row.values.join(" | ")}` : ""}`).join("\n")}\n${researchCompletionProblem(ledger, state.taskId, state.contractVersion) ?? "关键字段已达到完成条件。"}`);
			},
		});

		// —— 感知：监督者自己去拿事实，而不是信 executor 的自述 ——

		pi.registerTool({
			name: "git_diff",
			label: "Git Diff",
			description: "看 executor 工作目录里实际改了哪些文件（真相，不是屏幕）。含未跟踪的新文件。",
			parameters: Type.Object({}),
			// git diff 不显示未跟踪新文件，必须配 status --porcelain 才能抓到新建文件
			execute: async () =>
				text(
					sh(
						"echo '## status (含未跟踪):' && git status --porcelain && " +
							"echo '## tracked diff:' && git --no-pager diff --stat HEAD 2>/dev/null | head -100",
					),
				),
		});

		pi.registerTool({
			name: "run_tests",
			label: "Run Tests",
			description: "亲自跑测试套件，返回退出码与输出。这是判定完成的唯一可信依据。testCmd 为空时自动探测。",
			parameters: Type.Object({}),
			execute: async () => {
				if (!isCurrent()) return stale();
				const cmd = state.testCmd || detectTestCmd(state.workdir);
				if (!cmd) return text("未配置且无法探测测试命令；请在任务里说明如何验证（例如运行哪条命令）。");
				try {
					const out = sh(cmd);
					state.lastTestPassed = true;
					state.lastTestRevision = state.workRevision ?? 0;
					saveState(state);
					return text(`EXIT 0 (PASS)\n${out.slice(-4000)}`);
				} catch (e: unknown) {
					state.lastTestPassed = false;
					state.lastTestRevision = -1;
					saveState(state);
					const err = e as { stdout?: string; stderr?: string; status?: number };
					return text(`EXIT ${err.status ?? "?"} (FAIL)\n${(err.stdout ?? "") + (err.stderr ?? "")}`.slice(-4000));
				}
			},
		});

		// —— 建议：监督者不直接操作执行端，只把"下一步该做什么"交出去 ——

		pi.registerTool({
			name: "inject_directive",
			label: "Redo Directive",
			description:
				"给执行端的重做/改进指令——【会被自动发回执行端让它重做】。写成一条完整、可直接执行的指令：要补哪些数据/维度、怎么改、达标标准。别只说'不够好'。urgent=true 表示应立即处理。",
			parameters: Type.Object({ message: Type.String(), urgent: Type.Optional(Type.Boolean()) }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				state.workRevision = (state.workRevision ?? 0) + 1;
				state.lastTestPassed = false;
				state.lastTestRevision = -1;
				saveState(state);
				onSuggest(params.message, params.urgent ?? false);
				return text(`已给出建议: ${params.message}`);
			},
		});

		pi.registerTool({
			name: "set_true_intent",
			label: "True Intent",
			description:
				"写下你推断的【用户真实意图】——他字面说了 X，但他真正想要的是什么？为什么是现在提？拿到结果他要干什么？什么样的结果他会说'对，就是这个'？之后所有验收都对照这个真实意图，不对照字面目标。审目标时必须先调这个。",
			parameters: Type.Object({
				intent: Type.String({ description: "一段话：用户真正想要什么 + 做成什么样他才会满意" }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const it = (params.intent ?? "").trim();
				if (it.length < 15) return text("拒绝：太敷衍了。真实意图要写清楚他真正想要什么、为什么、做成什么样才算成——这是之后所有验收的尺子。");
				state.trueIntent = it;
				saveState(state);
				return text(`已记下真实意图，之后验收按它来：${it}`);
			},
		});

		pi.registerTool({
			name: "set_reasoning_audit",
			label: "Reasoning Audit",
			description:
				"对当前目标做认知红队并落盘：找用户自己可能没发现的隐藏假设、盲区、反证、替代路径和失败原因。不是风险套话；必须结合项目事实或外部证据。mark_complete 前强制要求。",
			parameters: Type.Object({
				user_value_function: Type.String({ description: "这单替用户最大化什么、不能牺牲什么；纳入时间、钱、风险、可逆性、机会成本和长期复利" }),
				hidden_assumptions: Type.String({ description: "目标依赖哪些未证明前提？最脆弱的一个是什么，依据是什么" }),
				blind_spots: Type.String({ description: "用户和执行端可能遗漏了哪些利益相关者、约束、二阶影响、机会成本或指标漏洞" }),
				disconfirming_evidence: Type.String({ description: "什么事实会推翻当前方向；你查到了什么反对证据或仍需验证什么" }),
				alternative_paths: Type.String({ description: "至少一个机制不同的替代方案，以及成本、可逆性、收益上限、失败代价比较" }),
				failure_premortem: Type.String({ description: "假设未来失败，哪项判断最可能今天就错了；不要只写执行不力" }),
				recommendation: Type.String({ description: "站在用户一边明确拍板：建议做什么、不做什么、为什么比替代方案的风险调整后净收益更高。禁止保持中立" }),
				verdict: Type.Union([Type.Literal("proceed"), Type.Literal("reframe"), Type.Literal("stop")]),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const fields = [
					params.user_value_function,
					params.hidden_assumptions,
					params.blind_spots,
					params.disconfirming_evidence,
					params.alternative_paths,
					params.failure_premortem,
					params.recommendation,
				].map((v) => (v ?? "").trim());
				if (fields.some((v) => v.length < 20)) {
					return text("拒绝：认知审计太敷衍。五项都要写出具体判断和依据，不能用‘存在风险、需要关注’之类套话。");
				}
				state.reasoningAudit = {
					taskId: state.taskId,
					contractVersion: state.contractVersion,
					goal: state.goal,
					userValueFunction: fields[0],
					hiddenAssumptions: fields[1],
					blindSpots: fields[2],
					disconfirmingEvidence: fields[3],
					alternativePaths: fields[4],
					failurePremortem: fields[5],
					recommendation: fields[6],
					verdict: params.verdict,
				};
				saveState(state);
				return text(
					params.verdict === "proceed"
						? "认知审计已记录：原方向暂时胜出，但验收时仍要用新证据复查这些前提。"
						: `认知审计判定=${params.verdict}：当前方向不能直接放行。请用 inject_directive 把更正后的方向发给执行端。`,
				);
			},
		});

		pi.registerTool({
			name: "set_goal_ledger",
			label: "Set Goal Ledger",
			description: "把多流程目标变成不可遗漏的验收账本。逐项写用户要什么和 done_when；之后所有项都必须核验，mark_complete 不会放过未完成项。",
			parameters: Type.Object({
				items: Type.Array(Type.Object({ id: Type.String(), requirement: Type.String(), done_when: Type.String() }), { minItems: 2 }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const items: GoalLedgerItem[] = (params.items ?? []).map((item) => ({ id: item.id.trim(), requirement: item.requirement.trim(), doneWhen: item.done_when.trim(), status: "pending", evidence: "" }));
				const error = validateGoalLedger(items);
				if (error) return text(`拒绝：${error}`);
				const ledger = saveGoalLedger(state.workdir, state.goal, items, state.scopeId, {
					taskId: state.taskId,
					contractVersion: state.contractVersion,
					preserveVerified: true,
				});
				return text(`目标账本已建立。\n${goalLedgerBrief(ledger)}`);
			},
		});

		pi.registerTool({
			name: "verify_goal_item",
			label: "Verify Goal Item",
			description: "用事实证据核验目标账本中的一个验收项。不能用“已完成”代替证据；所有项都通过前不得 mark_complete。",
			parameters: Type.Object({ id: Type.String(), evidence: Type.String() }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const evidence = (params.evidence ?? "").trim();
				if (evidence.length < 20) return text("拒绝：验收证据太短。写清核查方法、结果及它如何满足 done_when。");
				const current = loadGoalLedger(state.workdir, state.scopeId);
				if (current.taskId !== state.taskId || current.contractVersion !== state.contractVersion)
					return text("拒绝：目标账本属于旧合同版本。先按最新版要求 set_goal_ledger；未变化的已验证项会保留证据。");
				const ledger = verifyLedgerItem(state.workdir, (params.id ?? "").trim(), evidence, state.scopeId);
				return ledger ? text(`已核验 ${params.id}。\n${goalLedgerBrief(ledger)}`) : text("拒绝：找不到该目标账本项。先 set_goal_ledger。 ");
			},
		});

		pi.registerTool({
			name: "set_work_plan",
			label: "Set Progressive Work Plan",
			description: "针对大目标建立共享任务树：2-8 个有依赖、验收条件的子任务，只指定一个 current_id。监督和执行端都读取这份计划；每个子任务仍必须单独做渐进式量化建模。",
			parameters: Type.Object({
				items: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), objective: Type.String(), depends_on: Type.Array(Type.String()), done_when: Type.String() }), { minItems: 2, maxItems: 8 }),
				current_id: Type.String(),
			}),
				execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const ledger = loadGoalLedger(state.workdir, state.scopeId);
				const contract = loadTaskContract(state.workdir, state.scopeId);
				const fullTask = taskContractText(contract, state.goal);
				const items: WorkItem[] = (params.items ?? []).map((item) => ({ id: item.id.trim(), title: item.title.trim(), objective: item.objective.trim(), dependsOn: (item.depends_on ?? []).map((id) => id.trim()).filter(Boolean), doneWhen: item.done_when.trim() }));
				const currentId = (params.current_id ?? "").trim();
				const error = validateWorkPlan(fullTask, items, currentId);
				if (error) return text(`拒绝：${error}`);
				const plan = saveProgressivePlan(state.workdir, state.goal, items, currentId, state.scopeId, {
					taskId: state.taskId,
					contractVersion: state.contractVersion,
				});
				return text(`共享任务树已建立。\n${goalLedgerBrief(ledger)}\n${progressivePlanBrief(plan)}\n现在只给执行端下发 ${currentId} 的单点契约。`);
			},
		});

		pi.registerTool({
			name: "verify_work_item",
			label: "Verify Progressive Work Item",
			description: "用事实核验渐进任务树的当前阶段，并在依赖满足时只推进到一个 next_id。所有阶段逐项通过前不能 mark_complete。",
			parameters: Type.Object({
				id: Type.String(),
				evidence: Type.String({ description: "亲自核查到的证据，以及如何满足当前阶段 done_when" }),
				next_id: Type.Optional(Type.String({ description: "仍有阶段时必填，只能选依赖已全部验证的一项；最后一项不填" })),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const plan = loadProgressivePlan(state.workdir, state.scopeId);
				if (plan.taskId !== state.taskId || plan.contractVersion !== state.contractVersion)
					return text("拒绝：渐进任务树属于旧合同版本。先按最新版要求 set_work_plan；未变化的已验证阶段会保留证据。");
				try {
					const updated = verifyProgressiveWorkItem(
						state.workdir,
						(params.id ?? "").trim(),
						(params.evidence ?? "").trim(),
						(params.next_id ?? "").trim() || undefined,
						state.scopeId,
					);
					return text(`阶段已核验。\n${progressivePlanBrief(updated)}${updated.currentId ? `\n现在只为 ${updated.currentId} 建立新的单点契约。` : "\n全部阶段均已逐项核验。"}`);
				} catch (error) {
					return text(`拒绝：${error instanceof Error ? error.message : String(error)}`);
				}
			},
		});

		pi.registerTool({
			name: "set_focus_contract",
			label: "Single Point Contract",
			description:
				"为当前阶段只选一个可闭环的点。全局分析只用于选点；执行端在这个点被事实验证前不得横向铺开。每次扩张都必须重新调用，而且只能扩一个相邻点。",
			parameters: Type.Object({
				point: Type.String({ description: "本轮唯一交付点：一个具体结果，不是模块清单或完整系统" }),
				first_principle: Type.String({ description: "从第一性原理看，决定这个点成败的最底层因果是什么" }),
				variables: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "第一版真正进入模型的 1-5 个变量；每个都必须会改变输出" }),
				calculation: Type.String({ description: "最简单、可由人复算的公式/评分/判定规则：变量如何产生输出" }),
				output: Type.String({ description: "模型输出什么分数、等级、选择或可验证结果" }),
				baseline: Type.String({ description: "最小基线/阈值/对照样本，用来判断模型是否比拍脑袋更有用" }),
				done_when: Type.String({ description: "可观察、可运行或可核查的闭环条件" }),
				deferred: Type.Array(Type.String(), { minItems: 1, maxItems: 6, description: "明确这轮不做、留到以后再判断的范围" }),
				next_trigger: Type.String({ description: "只有出现什么真实证据，才值得扩到下一个相邻点" }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const point = (params.point ?? "").trim();
				const firstPrinciple = (params.first_principle ?? "").trim();
				const variables = (params.variables ?? []).map((x) => x.trim()).filter(Boolean);
				const calculation = (params.calculation ?? "").trim();
				const output = (params.output ?? "").trim();
				const baseline = (params.baseline ?? "").trim();
				const doneWhen = (params.done_when ?? "").trim();
				const deferred = (params.deferred ?? []).map((x) => x.trim()).filter(Boolean);
				const nextTrigger = (params.next_trigger ?? "").trim();
				const breadthSignals = point.match(/以及|同时|并且|全部|完整|一站式|端到端|全面/g) ?? [];
				if (point.length < 8 || point.length > 120 || breadthSignals.length >= 2) {
					return text("拒绝：这个 point 仍然像一组任务或完整系统。砍到一个可独立交付、可验证的点，其他内容放进 deferred。");
				}
				if (firstPrinciple.length < 15 || variables.length < 1 || variables.length > 5 || calculation.length < 12 || output.length < 6 || baseline.length < 10) {
					return text("拒绝：Minimum Viable Model 不完整。必须从第一性原理写清底层因果，只保留 1-5 个会改变输出的变量，并给出可复算规则、输出和基线。");
				}
				if (doneWhen.length < 12 || nextTrigger.length < 12 || deferred.length < 1) {
					return text("拒绝：单点契约不完整。必须写清闭环证据、至少一个明确不做项，以及由真实证据触发的下一点扩张条件。");
				}
				state.focusContract = {
					taskId: state.taskId,
					contractVersion: state.contractVersion,
					goal: state.goal,
					point,
					firstPrinciple,
					variables,
					calculation,
					output,
					baseline,
					doneWhen,
					deferred,
					nextTrigger,
					status: "active",
					evidence: "",
					decision: "unset",
				};
				saveState(state);
				return text(`当前只做这一个点：${point}\nMVM：${variables.join(" + ")} → ${calculation} → ${output}\n基线：${baseline}\n闭环标准：${doneWhen}\n其余已推迟：${deferred.join("；")}`);
			},
		});

		pi.registerTool({
			name: "verify_focus_contract",
			label: "Verify Single Point",
			description:
				"用事实确认当前点是否闭环，并决定停止还是只扩一个相邻点。当前点未闭环时不得调用；decision=expand 后必须重设新的单点契约，不能一次扩多个。",
			parameters: Type.Object({
				evidence: Type.String({ description: "亲自核查到的可运行/可观察证据，证明 done_when 已满足" }),
				model_result: Type.String({ description: "用当前变量和规则实际算出的结果，并与 baseline/阈值对照；必须可复核" }),
				decision: Type.Union([Type.Literal("stop"), Type.Literal("expand")]),
				reason: Type.String({ description: "为何现在停止，或哪条真实证据触发了扩一个相邻点" }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				if (
					state.focusContract.goal !== state.goal ||
					state.focusContract.taskId !== state.taskId ||
					state.focusContract.contractVersion !== state.contractVersion ||
					state.focusContract.status !== "active"
				) {
					return text("拒绝：当前没有有效的单点契约。先调 set_focus_contract，只选一个点。");
				}
				const evidence = (params.evidence ?? "").trim();
				const modelResult = (params.model_result ?? "").trim();
				const reason = (params.reason ?? "").trim();
				if (evidence.length < 20 || modelResult.length < 15 || reason.length < 15) return text("拒绝：不能凭感觉宣布单点闭环。写清事实证据、最小模型的实际计算/判定结果及基线对照、停止/扩张理由。");
				state.focusContract.status = "verified";
				state.focusContract.evidence = `${evidence}\n模型结果：${modelResult}\n决策理由：${reason}`;
				state.focusContract.decision = params.decision;
				saveState(state);
				return text(
					params.decision === "stop"
						? "当前点已闭环，证据成立；没有足够理由继续扩张。"
						: "当前点已闭环且出现了扩张证据。现在只能选择一个相邻点，重新调用 set_focus_contract 后再让执行端继续。",
				);
			},
		});

		pi.registerTool({
			name: "set_progress",
			label: "Set Progress",
			description: "更新计划进度 0-100",
			parameters: Type.Object({ progress: Type.Number(), note: Type.Optional(Type.String()) }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				state.progress = Math.max(0, Math.min(100, params.progress));
				if (params.note) state.findings.push(params.note);
				saveState(state);
				return text(`progress=${state.progress}`);
			},
		});

		pi.registerTool({
			name: "remember",
			label: "Remember",
			description:
				"把当前任务的持久经验写进本会话记忆（.goal-mode-pi/runs/<session>/supervisor-memory.md）。只存本任务后续仍会用到的已验证事实、验收口径和项目坑；严禁写其他任务的结论，也别存流水账。",
			parameters: Type.Object({ lesson: Type.String({ description: "一条经验，一句话说清它是什么、下次判断怎么用" }) }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const l = (params.lesson ?? "").trim();
				if (l.length < 10) return text("拒绝：太短了。写清楚这条经验是什么、下次判断时怎么用。");
				appendSupervisorMemory(state.workdir, l, state.scopeId, state.taskId);
				return text(`记住了：${l}`);
			},
		});

		pi.registerTool({
			name: "remember_user",
			label: "Remember User",
			description:
				"把跨项目都成立的用户长期信息写入全局记忆（~/.goal-mode-pi/user-memory.md）：稳定偏好、长期目标、决策原则、风险承受能力、不可触碰的底线。严禁写某个项目的临时事实、一次性任务或未经用户表达的心理猜测；那些应使用 remember 存项目记忆。",
			parameters: Type.Object({
				lesson: Type.String({ description: "一条跨项目稳定信息，并说明以后做判断时如何使用" }),
			}),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const l = (params.lesson ?? "").trim();
				if (l.length < 15) return text("拒绝：用户长期记忆太短。写清稳定偏好/原则是什么，以及以后判断时怎么用。");
				if (/本项目|这个项目|当前任务|这次|今天的文件|当前代码/.test(l)) {
					return text("拒绝：这看起来是项目或任务临时信息，请用 remember 存项目记忆，不要污染跨项目用户画像。");
				}
				return text(appendUserMemory(l) ? `已记入用户长期记忆：${l}` : "这条用户长期记忆已经存在，不重复追加。");
			},
		});

		pi.registerTool({
			name: "log_finding",
			label: "Log Finding",
			description: "记录一条持久化发现（如 executor 试图跳过测试）",
			parameters: Type.Object({ finding: Type.String() }),
			execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				state.findings.push(params.finding);
				saveState(state);
				return text("已记录");
			},
		});

		pi.registerTool({
			name: "mark_complete",
			label: "Mark Complete",
			description:
				"标记目标达成。门槛很高——你必须亲自读过产出文件、亲自挑过毛病、用工具取过证。代码类还必须 run_tests PASS。如果你没亲自检查产出就尝试标记完成，会被自动拒绝。",
			parameters: Type.Object({
				files_inspected: Type.String({ description: "你亲自读了哪些产出文件（文件路径），用什么工具读的" }),
				flaws_found: Type.String({ description: "你挑毛病挑到了什么？如果真的没找到问题，写'逐段检查后未发现问题'并说明你检查了哪些方面" }),
				verification_method: Type.String({ description: "你用了哪些工具取证，如 run_tests/git_diff/web_search/web_fetch/read/bash" }),
				evidence: Type.String({ description: "核查结论：你验证了什么、结果是什么、为什么达标——必须回答【用户的真实意图】满足了没，不是字面目标" }),
			}),
				execute: async (_id, params) => {
				if (!isCurrent()) return stale();
				const contract = loadTaskContract(state.workdir, state.scopeId);
				const taskId = contract.taskId || state.taskId;
				const contractVersion = contract.version || state.contractVersion;
				const ledger = loadGoalLedger(state.workdir, state.scopeId);
				if (needsGoalLedger(contract, state.goal) && !ledger.items.length) {
					return text("拒绝：这是多流程目标但尚未建立目标账本。先调 set_goal_ledger，把每一项用户流程写成可验收项。 ");
				}
				if (ledger.items.length && (ledger.taskId !== taskId || ledger.contractVersion !== contractVersion)) {
					return text(`拒绝：目标账本属于旧合同版本（账本 v${ledger.contractVersion}，当前 v${contractVersion}）。按最新版要求重建后才能完成。`);
				}
				if (ledger.items.length && ledger.items.some((item) => item.status !== "verified")) {
					return text(`拒绝：目标账本还有未核验项：${ledger.items.filter((item) => item.status !== "verified").map((item) => item.id).join("、")}。逐项调 verify_goal_item 留下事实证据后才能完成。`);
				}
				const fullTask = taskContractText(contract, state.goal);
				const plan = loadProgressivePlan(state.workdir, state.scopeId);
				if (needsWorkBreakdown(fullTask)) {
					if (!plan.items.length) return text("拒绝：这是大任务但尚未建立渐进任务树。先调 set_work_plan 拆成有依赖和验收条件的阶段。");
					if (plan.taskId !== taskId || plan.contractVersion !== contractVersion)
						return text(`拒绝：渐进任务树属于旧合同版本（任务树 v${plan.contractVersion}，当前 v${contractVersion}）。按最新版要求重建后才能完成。`);
					const unfinished = plan.items.filter((item) => item.status !== "verified");
					if (unfinished.length) return text(`拒绝：渐进任务树还有未核验阶段：${unfinished.map((item) => item.id).join("、")}。逐项调 verify_work_item 留下事实证据。`);
				}
				if (state.focusContract.goal !== state.goal || state.focusContract.taskId !== taskId || state.focusContract.contractVersion !== contractVersion) {
					return text("拒绝：当前目标还没有单点契约。先调 set_focus_contract，砍到一个点再执行。");
				}
				if (state.focusContract.status !== "verified" || state.focusContract.decision !== "stop") {
					return text("拒绝：当前点还没有事实闭环，或监督决定继续扩张。先 verify_focus_contract；扩张时只能重设一个相邻点，不能直接宣布整体完成。");
				}
				if (state.reasoningAudit.goal !== state.goal || state.reasoningAudit.taskId !== taskId || state.reasoningAudit.contractVersion !== contractVersion) {
					return text("拒绝：当前目标还没有完成认知审计。先调 set_reasoning_audit，找隐藏假设、盲区、反证、替代路径和失败预演。");
				}
				if (state.reasoningAudit.verdict !== "proceed") {
					return text(`拒绝：认知审计结论是 ${state.reasoningAudit.verdict}。先纠正目标/路径并重新审计为 proceed，不能把执行完成冒充方向正确。`);
				}
				if (state.reasoningAudit.userValueFunction.length < 20 || state.reasoningAudit.recommendation.length < 20) {
					return text("拒绝：监督没有站在用户利益一边明确拍板。先定义用户利益函数，并给出风险调整后净收益最高的明确建议，不能保持中立。");
				}
				const isCode = !!(state.testCmd || detectTestCmd(state.workdir));
				if (isCode && (!state.lastTestPassed || state.lastTestRevision !== state.workRevision)) {
					return text("拒绝：代码类任务缺少覆盖当前修改版本的测试 PASS。监督下发过新修改要求后，旧 PASS 会自动失效；请重新 run_tests。");
				}
				const taskProblem = taskCompletionProblem(loadTaskLedger(state.workdir, state.scopeId), taskId, contractVersion);
				if (taskProblem) return text(`拒绝：${taskProblem}`);
				if (isCode && isProductBuildTask(`${state.goal}\n${state.latestRequest}`)) {
					const productProblem = implementationProblem(loadProductRequirements(state.workdir, state.scopeId), taskId, contractVersion);
					if (productProblem) return text(`拒绝：${productProblem}`);
				}
				if (/调研|分析|研究|对比|评估|报告|市场|数据|可行性/.test(`${state.goal}\n${state.latestRequest}`)) {
					const researchProblem = researchCompletionProblem(loadResearchLedger(state.workdir, state.scopeId), taskId, contractVersion);
					if (researchProblem) return text(`拒绝：${researchProblem} 不能把单页抓取失败或单一转载写成“未公开”。`);
				}
				const files = (params.files_inspected ?? "").trim();
				const flaws = (params.flaws_found ?? "").trim();
				const method = (params.verification_method ?? "").trim();
				const evidence = (params.evidence ?? "").trim();
				if (!files || files.length < 5) {
					return text("拒绝：files_inspected 为空。你必须亲自用 read/bash 打开产出文件逐段读过，不能只看执行端屏幕上说了什么。去读文件。");
				}
				if (!flaws || flaws.length < 10) {
					return text("拒绝：flaws_found 为空。你的职责是挑毛病——逻辑漏洞、事实硬伤、遗漏、质量问题。如果真的没找到，写清楚你检查了哪些方面。");
				}
				if (!method) {
					return text("拒绝：verification_method 为空。你必须说明用了哪些工具取证。");
				}
				if (evidence.length < 30) {
					return text("拒绝：evidence 太短（至少30字）。要写清楚你核查了什么、具体结果、为什么满足目标。");
				}
				const hasInspection = /read|bash|cat|git_diff/i.test(method);
				if (!hasInspection) {
					return text("拒绝：你没有亲自查看产出文件（verification_method 里没有 read/bash/git_diff）。监督必须亲自看产出，不能只听执行端汇报。");
				}
				state.completed = true;
				state.progress = 100;
				state.findings.push(`检查文件：${files}\n发现问题：${flaws}\n核查方法：${method}\n核查结论：${evidence}`);
				saveState(state);
				const candidate = deriveExperienceCandidate(state.workdir, taskId, state.goal, loadTaskLedger(state.workdir, state.scopeId));
				return text(candidate
					? `已确认目标达成；已从成功路径生成候选经验 ${candidate.id}。它需独立任务验证后才会晋升，不能直接当长期规则。`
					: "已确认目标达成。没有足够明确的成功路径可自动沉淀；如有可复用经验，调 propose_experience 以证据、边界和反例要求手工提议。");
			},
		});
	};
}
