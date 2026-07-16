import assert from "node:assert/strict";
import { automaticSessionTitle } from "../src/session-title.ts";

assert.equal(automaticSessionTitle("帮我试试 computer use 这个能力,试试看"), "试试 computer use 这个能力,试试看");
assert.equal(automaticSessionTitle("研究下这个产品https://bojilab.com/home的这个需求:分发功能为什么没有自动写文案"), "这个产品bojilab.com的这个需求:分发功能为什么没有自动…");
assert.equal(automaticSessionTitle("我要做个作品集,内容上会有产品,skill,但是最终都是以链接的形式,所以要更漂亮地展示。后面再做网页。", 18), "做个作品集,内容上会有产品,skil…");
assert.equal(automaticSessionTitle("   \n "), "");

console.log("✅ 会话自动命名：首条用户输入会生成短标题");
