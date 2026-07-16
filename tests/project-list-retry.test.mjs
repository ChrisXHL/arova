import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(join(root, "renderer/app.js"), "utf8");

assert.match(js, /fetch\("\/projects", \{ cache: "no-store" \}\)/, "项目列表请求不能读陈旧缓存");
assert.match(js, /if \(attempt < 4\)/, "首次加载失败必须自动重试");
assert.match(js, /projectsRetryTimer = setTimeout/, "后端较久未就绪时也必须持续后台恢复，不能永久显示项目消失");
assert.match(js, /projectsLoadState === "ready"/, "空列表只有在成功读取后才能显示");
assert.match(js, /正在恢复项目列表/, "加载失败时不能误报没有项目");
assert.match(js, /showHome\(last\)/, "启动时应恢复项目主页而非自动启动 pi");
assert.doesNotMatch(js, /selectProject\(last\)/, "启动时不得自动进入 pi 会话");

const server = readFileSync(join(root, "src/server.ts"), "utf8");
assert.match(server, /首屏只需要项目名/, "项目列表首屏不得同步读取所有历史");
assert.doesNotMatch(server.slice(server.indexOf("function projectList"), server.indexOf("function projectHistory")), /projectHistory\(/, "项目接口必须保持轻量");

const electron = readFileSync(join(root, "electron/main.cjs"), "utf8");
assert.match(electron, /app\.requestSingleInstanceLock\(\)/, "应用必须阻止多实例抢占端口");
assert.match(server, /async function loadLiveRuntime\(\)/, "pi 运行时必须延后加载");
assert.match(server, /await loadLiveRuntime\(\)/, "只有进入 websocket 会话时才加载 pi 运行时");
assert.match(server, /automaticSessionTitle\(t\)/, "首条用户输入必须立即命名会话");
assert.match(server, /includeEmptySessions/, "无输入会话不应作为普通历史展示");
assert.match(js, /function onHistoryChanged\(cwd\)/, "历史刷新必须有独立快速通道");
assert.doesNotMatch(js.slice(js.indexOf("function onHistoryChanged"), js.indexOf("function openHistoryItem")), /loadProjects\(/, "历史变更不能先等待项目列表请求");
assert.match(js, /list\.replaceChildren\(next\)/, "历史列表应在新数据到齐后一次替换，避免闪动");

// 真实事故回归：关闭一个项目后，轻量 /projects 响应不带 history，
// 其他项目的内存历史、待办和队列必须原样保留。
const mergeStart = js.indexOf("function mergeProjectSnapshots");
const mergeEnd = js.indexOf("async function loadProjects", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "项目响应必须通过统一状态合并函数");
const mergeSource = js.slice(mergeStart, mergeEnd);
const merged = vm.runInNewContext(`${mergeSource}\nmergeProjectSnapshots(
  [{ path: "/keep", name: "keep" }],
  [
    { path: "/remove", name: "remove", history: [{ goal: "被关闭项目" }] },
    { path: "/keep", name: "keep", history: [{ goal: "必须保留" }], pending: 3, queues: [{ id: "q1" }] }
  ]
)`);
assert.equal(merged.length, 1, "被关闭的项目应从列表移除");
assert.equal(merged[0].history[0].goal, "必须保留", "其他项目的历史不能消失");
assert.equal(merged[0].pending, 3, "其他项目的待办数不能清零");
assert.equal(merged[0].queues[0].id, "q1", "其他项目的队列不能消失");
const removeBody = js.slice(js.indexOf("async function removeProject"), js.indexOf("async function onAddProj"));
assert.match(removeBody, /mergeProjectSnapshots\(body\.projects \|\| \[\]\)/, "关闭项目必须合并保留其他项目的已加载状态");

console.log("✅ 项目列表恢复：短暂请求失败会重试，不会误显示为空");
