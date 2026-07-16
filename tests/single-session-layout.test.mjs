import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "renderer/index.html"), "utf8");
const js = readFileSync(join(root, "renderer/app.js"), "utf8");

assert.match(html, /\.content\[hidden\]\s*\{\s*display:\s*none;/, "主会话隐藏时必须真正退出布局");
assert.match(js, /\$\("mainContent"\)\.hidden\s*=\s*id\s*!==\s*"main";/, "切换会话必须隐藏主会话区域");
assert.match(js, /\$\("threadFrames"\)\.classList\.toggle\("active",\s*id\s*!==\s*"main"\);/, "切换会话必须只显示后台会话区域");

console.log("✅ 单会话布局：历史切换时只显示一个会话页面");
