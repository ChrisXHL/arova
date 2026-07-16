// 仅用于 preview/launch：在加载 server 前打开 DEMO 模式。
process.env.DEMO = "1";
await import("./server.ts");
