import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const renderer = readFileSync(join(root, "renderer/app.js"), "utf8");
const server = readFileSync(join(root, "src/server.ts"), "utf8");
assert.match(renderer, /attachCustomKeyEventHandler[\s\S]*?e\.key === "Escape"[\s\S]*?sendTerminalInput\("\\x1b"\)/);
assert.match(server, /if \(s === "\\x1b"\) \{[\s\S]*?rateLimitRecovery\.cancel\(\);[\s\S]*?supervisor\.cancelCurrent\("用户按 Esc 取消"\);[\s\S]*?\}/);
console.log("✅ Esc 取消：终端明确转发控制字符，监督端立即同步停止");
