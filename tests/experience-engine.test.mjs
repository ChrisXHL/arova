import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { deriveExperienceCandidate, experiencePackText, loadExperienceCards, promoteExperience, proposeExperience, recordExperienceOutcome, retrieveExperiencePack, reviseExperience } = await import(join(root, "src/experience-engine.ts"));
const { createSupervisorExtension } = await import(join(root, "src/supervisor-extension.ts"));
const { loadState } = await import(join(root, "src/state.ts"));
const work = mkdtempSync(join(tmpdir(), "gm-experience-"));
let ok = 0, bad = 0;
const t = (name, pass) => pass ? ok++ : (bad++, console.log("❌", name));

const first = proposeExperience(work, { id: "waf-browser", taskId: "task-a", trigger: "官网文本抓取被 WAF 拦截或页面为空", action: "切换已登录浏览器读取 DOM、目录和附件", boundary: "不能绕过登录、验证码、付费墙或访问控制", evidence: "Unitree 页面 curl 返回 EdgeOne 拦截，但 Chrome DOM 可读取文档目录", tags: ["WAF", "browser"] });
t("候选经验从证据创建", first.level === "candidate" && first.versions.length === 1 && first.confidence === 0.35);
t("任务账本成功路径可自动生成候选", (() => { const card = deriveExperienceCandidate(work, "task-auto", "修复登录超时", { taskId: "task-auto", contractVersion: 1, goal: "修复登录超时", requirements: [{ id: "login", description: "登录成功", evidence: "运行日志 HTTP 200" }], facts: [], hypotheses: [], gaps: [], attempts: [{ action: "读取服务端日志并调整连接池超时", outcome: "success", blocker: "none", learned: "调整超时后集成测试通过", nextAction: "复测", at: "2026-07-15" }], nextAction: "" }); return card?.level === "candidate" && !!deriveExperienceCandidate(work, "task-auto", "修复登录超时", { taskId: "task-auto", contractVersion: 1, goal: "修复登录超时", requirements: [], facts: [], hypotheses: [], gaps: [], attempts: [], nextAction: "" }) === false; })());
t("一次任务不能晋升", (() => { try { promoteExperience(work, first.id); return false; } catch { return true; } })());
const supported = recordExperienceOutcome(work, { id: first.id, taskId: "task-b", outcome: "supported", evidence: "另一个动态官网在浏览器中可读，文本抓取为空", triggerMatched: true });
t("独立任务成功增强置信度", supported.supportTaskIds.length === 2 && supported.confidence > first.confidence);
const project = promoteExperience(work, first.id);
t("两次独立任务晋升项目经验", project.level === "project");
const revised = reviseExperience(work, { id: first.id, trigger: "官网文本抓取被 WAF 拦截或页面为空", action: "切换已登录浏览器读取 DOM、目录、附件和官方 AI 指向资料", boundary: "若浏览器仍要求登录或验证码，记录缺口并请用户处理；不得绕过", evidence: "第二次任务验证浏览器路径有效", reason: "补充登录墙边界与官方 AI 用法" });
t("经验更新保留版本历史", revised.versions.length === 2 && revised.versions[0].action.includes("目录和附件") && revised.versions[1].boundary.includes("不得绕过"));
t("相关任务可检索且只注入晋升经验", retrieveExperiencePack(work, "WAF 动态官网浏览器资料采集").length === 1 && experiencePackText(retrieveExperiencePack(work, "WAF 动态官网浏览器资料采集")).includes("置信度"));
const refuted = recordExperienceOutcome(work, { id: first.id, taskId: "task-c", outcome: "refuted", evidence: "相同 WAF 条件下浏览器也无权限，官方要求人工授权", triggerMatched: true });
const deprecated = recordExperienceOutcome(work, { id: first.id, taskId: "task-d", outcome: "refuted", evidence: "相同条件下浏览器被明确禁止访问，必须改走用户授权流程", triggerMatched: true });
t("重复同条件反例会废弃经验", refuted.level !== "deprecated" && deprecated.level === "deprecated" && retrieveExperiencePack(work, "WAF 浏览器").length === 0);
t("经验事件日志可审计", readFileSync(join(work, ".goal-mode-pi", "experience", "events.jsonl"), "utf8").split("\n").filter(Boolean).length >= 6);

const state = loadState({ taskId: "task-e", contractVersion: 1, goal: "研究官网资料", workdir: work, testCmd: "" });
const tools = new Map(); createSupervisorExtension(state, () => {})({ registerTool: (tool) => tools.set(tool.name, tool) });
const text = (r) => r.content[0].text;
t("监督端经验工具已注册", ["propose_experience", "record_experience_outcome", "revise_experience", "promote_experience", "inspect_experience_pack"].every((name) => tools.has(name)));
t("候选经验不会与长期卡混淆", loadExperienceCards(work).filter((card) => card.level === "candidate").length === 1 && loadExperienceCards(work).some((card) => card.id.includes("task-task-auto")));

rmSync(work, { recursive: true, force: true });
console.log(bad ? `❌ ${bad} 项失败` : `✅ 经验引擎：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
