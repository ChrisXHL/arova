import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const renderer = readFileSync(join(root, "renderer/app.js"), "utf8");
assert.match(renderer, /e\.key === "Enter" && e\.shiftKey[\s\S]*?sendTerminalInput\("\\x1b\[13;2u"\)/, "Shift+Enter 必须转发 Pi 识别的换行键序列");
assert.match(renderer, /e\.key === "Escape"[\s\S]*?sendTerminalInput\("\\x1b"\)/, "Shift+Enter 不能破坏 Esc 取消");
console.log("✅ Shift+Enter：发送 Pi 原生换行序列，普通 Enter 仍由终端提交");
