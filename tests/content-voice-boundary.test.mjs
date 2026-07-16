import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { classifyTask, readerFacingContentContext, taskExecutionContext } = await import(join(root, "src/policy.ts"));
const { contentVoiceProblem, internalTermsInContent } = await import(join(root, "src/content-voice-guard.ts"));
const extension = (await import(join(root, "src/thinking-chain-extension.ts"))).default;

let ok = 0, bad = 0;
const t = (name, pass) => pass ? ok++ : (bad++, console.log("❌", name));

t("官网与落地页会进入内容模式", classifyTask("写官网首页", "/tmp").includes("content") && classifyTask("写产品落地页", "/tmp").includes("content"));
const readerContext = readerFacingContentContext("为一款效率产品写官网首页", "/tmp");
t("读者模式明确禁止内部工作词", readerContext.includes("读者") && readerContext.includes("任务账本") && readerContext.includes("用户能做成什么"));
t("工程细则不再常驻内容任务上下文", !taskExecutionContext("为效率产品写官网首页", "/tmp").includes("代码执行模式") && !taskExecutionContext("为效率产品写官网首页", "/tmp").includes("研究执行模式"));
t("代码任务只在发生时注入代码细则", taskExecutionContext("修复登录接口代码", "/tmp").includes("代码执行模式"));
t("技术文档不被错误当作营销文案", readerFacingContentContext("写 SDK 开发文档", "/tmp").includes("技术内容模式"));
t("只识别本应用内部术语", internalTermsInContent("这里有系统、流程和证据，但没有内部机制").length === 0);
t("内部术语泄漏会被指出", contentVoiceProblem("我们通过任务账本和认知审计保证交付质量").includes("任务账本"));
t("用户向文案不会被误伤", !contentVoiceProblem("少开一次会，也能知道今天最该推进的事。"));

const work = mkdtempSync(join(tmpdir(), "gm-content-voice-"));
const handlers = {}, tools = new Map();
extension({ on: (name, handler) => (handlers[name] = handler), registerTool: (tool) => tools.set(tool.name, tool), getCommands: () => [] });
handlers.session_start({ cwd: work });
const transformed = handlers.input({ text: "为效率产品写官网首页文案" });
t("执行端在收到内容任务时注入读者模式", transformed?.action === "transform" && transformed.text.includes("读者内容模式"));
await tools.get("focus_step").execute("focus", {
  point: "写出首页首屏的用户价值表达", first_principle: "读者需要在短时间内判断产品是否能解决眼前困扰", variables: ["目标场景", "具体结果"], calculation: "场景和结果都明确才保留这句文案", output: "首屏是否让目标用户愿意继续阅读", baseline: "读者看完十秒仍说不清产品价值就视为失败", done_when: "首屏能说明给谁、解决什么和下一步动作", not_doing: ["暂不写完整官网"], next_trigger: "首屏通过读者检查后再补充功能说明"
});
const blocked = handlers.tool_call({ toolName: "write", input: { path: join(work, "index.html"), content: "<h1>任务账本让团队高效协作</h1>" } });
t("写入网站时会拦截内部术语", blocked?.block === true && blocked.reason.includes("内部工作语言"));
const allowed = handlers.tool_call({ toolName: "write", input: { path: join(work, "index.html"), content: "<h1>今天最该推进的事，一眼就知道</h1>" } });
t("正常用户向文案不被阻断", allowed == null);

rmSync(work, { recursive: true, force: true });
console.log(bad ? `❌ ${bad} 项失败` : `✅ 内容表达边界：全部 ${ok} 项通过`);
process.exit(bad ? 1 : 0);
