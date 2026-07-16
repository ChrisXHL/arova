import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "electron/main.cjs"), "utf8");
const preload = readFileSync(join(root, "electron/preload.cjs"), "utf8");
const renderer = readFileSync(join(root, "renderer/app.js"), "utf8");

assert.match(main, /nodeIntegrationInSubFrames:\s*true/, "多会话 iframe 必须加载 preload 才能读取拖入文件的真实路径");
assert.match(preload, /webUtils\.getPathForFile\(file\)/, "preload 必须通过 Electron webUtils 转换拖入文件路径");
assert.match(preload, /materializeDroppedFile/, "路径桥接失败时 preload 必须能请求安全临时副本");
assert.match(main, /materialize-dropped-file/, "主进程必须接收临时副本请求");
assert.match(renderer, /bridge\?\.pathForFile/, "终端拖放必须优先调用 preload 的路径转换桥");
assert.match(renderer, /window\.parent !== window/, "历史 iframe 未及时注入桥接时必须回退到父窗口桥接");
assert.match(renderer, /materializeDroppedFile\(file\.name, await file\.arrayBuffer\(\)\)/, "原生路径缺失时必须保留拖入文件内容为可读临时副本");
assert.doesNotMatch(renderer, /file\.path\s*\|\|\s*file\.name/, "不能用文件名冒充绝对路径");
assert.match(renderer, /没能读取拖入文件的完整路径/, "路径转换失败必须给用户明确反馈");
assert.match(renderer, /function sendTerminalInput\(text\)[\s\S]*?pendingInput \+= text/, "PTY 未连接时必须缓存拖入的文件路径");
assert.match(renderer, /if \(text\) \{ sendTerminalInput\(text \+ " "\)/, "文件拖放必须与键盘输入共用可靠发送通道");
assert.doesNotMatch(renderer, /mode !== "live" \|\| !ws \|\| ws\.readyState !== 1/, "历史恢复期间不能因 PTY 尚未连接而静默丢弃文件路径");
assert.match(renderer, /try \{ ws\.send\(queued\); pendingInput = ""; \} catch \{\}/, "只有补发成功后才能清空待发送路径");

console.log("✅ 文件拖放：会话 iframe 可取得绝对路径，历史恢复期间会缓存并补发路径");
