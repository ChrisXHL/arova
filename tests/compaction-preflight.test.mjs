import assert from "node:assert/strict";
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const small = [{ type: "message", id: "u", parentId: null, message: { role: "user", content: "短任务" } }];
assert.equal(prepareCompaction(small, { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }), undefined);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = readFileSync(join(root, "src/thinking-chain-extension.ts"), "utf8");
const renderer = readFileSync(join(root, "renderer/app.js"), "utf8");
assert.match(extension, /return !!prepareCompaction\(entries as never\[\], \{ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 \}\)/);
assert.match(renderer, /typeof e\.text === "string" \? e\.text : ""/);
console.log("✅ 压缩预检：只有 Pi 判定有旧段时才调用压缩，空监督增量不会显示 null");
