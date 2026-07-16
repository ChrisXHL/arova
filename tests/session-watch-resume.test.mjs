// 续接会话不能重放旧 user 消息：node --experimental-strip-types tests/session-watch-resume.test.mjs
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionWatch, visibleUserText } from "../src/session-watch.ts";

const work = mkdtempSync(join(tmpdir(), "gm-watch-resume-"));
const dir = join(work, "session");
mkdirSync(dir);
const file = join(dir, "chat.jsonl");
const msg = (role, text) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n";
const cleaned = visibleUserText('<skill name="demo">自动注入规则</skill>\n\n这是用户真正的问题');
writeFileSync(file, msg("user", "旧问题") + msg("assistant", "旧回答"));

const watch = new SessionWatch(dir);
const users = [];
const cancellations = [];
const turns = [];
watch.on("user-task", (t) => users.push(t));
watch.on("turn-cancelled", (reason) => cancellations.push(reason));
watch.on("turn-end", (text) => turns.push(text));
watch.start({ fromEnd: true });
await new Promise((r) => setTimeout(r, 550));
const oldSkipped = users.length === 0;
appendFileSync(file, msg("user", "续接后的新问题"));
await new Promise((r) => setTimeout(r, 650));
watch.stop();

// 取消前即使已有部分文本，也不能再被当作正常 turn-end 交给监督。
watch.handleLine(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "未完成内容" }] } }));
watch.handleLine(JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "aborted", errorMessage: "用户取消", content: [] } }));
watch.onIdle();

const newSeenOnce = users.length === 1 && users[0] === "续接后的新问题";
const skillStripped = cleaned === "这是用户真正的问题";
const cancelSeen = cancellations.length === 1 && cancellations[0] === "用户取消" && turns.length === 0;

// “复用未互动会话”目录起初没有 jsonl；Pi 会在用户首次提交后才创建它。
// 此时 fromEnd 只能跳过启动时已有的历史，不能吞掉这条首个任务。
const emptyDir = join(work, "empty-session");
mkdirSync(emptyDir);
const freshFile = join(emptyDir, "first-turn.jsonl");
const freshWatch = new SessionWatch(emptyDir);
const freshUsers = [];
freshWatch.on("user-task", (t) => freshUsers.push(t));
freshWatch.start({ fromEnd: true });
await new Promise((r) => setTimeout(r, 550));
writeFileSync(freshFile, msg("user", "空会话里的第一个真实任务"));
await new Promise((r) => setTimeout(r, 650));
freshWatch.stop();
const firstTaskSeen = freshUsers.length === 1 && freshUsers[0] === "空会话里的第一个真实任务";

rmSync(work, { recursive: true, force: true });
if (!oldSkipped || !newSeenOnce || !skillStripped || !cancelSeen || !firstTaskSeen) {
	console.error("❌ 续接/取消监听失败", { oldSkipped, users, skillStripped, cancellations, turns, freshUsers });
  process.exit(1);
}
console.log("✅ 续接监听：旧消息不重放；空会话首任务不会丢；取消生成不会触发监督验收");
