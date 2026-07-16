// 壳：项目侧栏 + 每个项目的历史（像 Claude/ChatGPT）。运行时左=真实 pi 终端，右=把关面板。

const $ = (id) => document.getElementById(id);
const launchParams = new URLSearchParams(location.search);
const embeddedThread = launchParams.get("embedded") === "1";
let mainThreadSession = "";
let threadSeq = 1;
let activeThreadView = "main";
const openingThreadByPath = new Map();

function threadCwd() {
  if (activeThreadView === "main") return current;
  return $(activeThreadView)?.dataset.cwd || current;
}
function activeThreadSession() {
  return activeThreadView === "main" ? mainThreadSession : ($(activeThreadView)?.dataset.session || "");
}
function activateThreadView(id) {
  activeThreadView = id;
  $("mainContent").hidden = id !== "main";
  $("threadFrames").classList.toggle("active", id !== "main");
  for (const frame of document.querySelectorAll(".thread-frame")) frame.classList.toggle("active", frame.id === id);
  $("rechoose").hidden = id === "main" ? !mode : false;
  renderSidebar();
  if (id !== "main") $(id)?.contentWindow?.postMessage({ type: "thread-activated" }, location.origin);
}
function closeThreadView(id) {
  const frame = $(id); if (!frame) return;
  const wasActive = activeThreadView === id;
  frame.remove();
  if (wasActive) activateThreadView("main");
}
function requestThread(path, session = "") {
  if (!path) return;
  if (embeddedThread) {
    parent.postMessage({ type: "open-thread", path, session }, location.origin);
    return;
  }
  // “新会话”若尚未输入过，就继续使用它。这样连续点新建不会留下空白会话。
  if (!session) {
    // 新 iframe 还没把 session id 回传时，同一路径只能有一个正在启动的空会话。
    const starting = [...document.querySelectorAll(".thread-frame")].find((frame) => frame.dataset.cwd === path && !frame.dataset.session);
    if (starting) return activateThreadView(starting.id);
    if (mode === "live" && activeThreadView === "main" && !mainThreadSession) return activateThreadView("main");
    if (openingThreadByPath.has(path)) return;
    const opening = reusableSession(path)
      .then((id) => openThread(path, id))
      .finally(() => openingThreadByPath.delete(path));
    openingThreadByPath.set(path, opening);
    return;
  }
  openThread(path, session);
}
async function reusableSession(path) {
  try {
    const r = await fetch(`/sessions/reusable?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (r.ok) return (await r.json()).session || "";
  } catch {}
  return "";
}
function openThread(path, session = "") {
  if (session && session === mainThreadSession) return activateThreadView("main");
  for (const frame of document.querySelectorAll(".thread-frame")) {
    if (session && frame.dataset.session === session && frame.dataset.cwd === path) return activateThreadView(frame.id);
  }
  const id = `threadFrame${++threadSeq}`;
  const frame = document.createElement("iframe");
  frame.id = id; frame.className = "thread-frame"; frame.dataset.cwd = path; frame.dataset.session = session;
  frame.src = `/?embedded=1&cwd=${encodeURIComponent(path)}${session ? `&session=${encodeURIComponent(session)}` : ""}`;
  $("threadFrames").appendChild(frame);
  activateThreadView(id);
}
addEventListener("message", (event) => {
  if (event.origin !== location.origin || !event.data) return;
  if (event.data.type === "open-thread") requestThread(event.data.path, event.data.session || "");
  if (event.data.type === "thread-session") {
    for (const frame of document.querySelectorAll(".thread-frame")) {
      if (frame.contentWindow === event.source) {
        frame.dataset.session = event.data.session || "";
        renderSidebar();
      }
    }
  }
});
addEventListener("message", (event) => { if (event.data?.type === "thread-activated") { scheduleFit(); try { term?.focus(); } catch {} } });

// ============ 右栏：把关面板（SSE 常驻）============
const supFeed = $("supFeed");
let supMsg = null;
let activeRunToken = "";
function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }
function add(node) { const stick = atBottom(supFeed); supFeed.appendChild(node); if (stick) supFeed.scrollTop = supFeed.scrollHeight; }
function clearEmpty() { const e = supFeed.querySelector(".empty"); if (e) e.remove(); }
function el(cls, text) { clearEmpty(); const d = document.createElement("div"); d.className = cls; if (text != null) d.textContent = text; add(d); return d; }

// 把工具函数名说成人话（用户看的是"AI 在做什么"，不是函数名）
const TOOL_CN = {
	read: "读文件", bash: "运行命令", edit: "修改文件", write: "写文件",
	git_diff: "看改了哪些文件", run_tests: "跑一遍测试", web_search: "上网查", web_fetch: "打开链接看",
	mark_complete: "确认搞定", inject_directive: "提建议", set_progress: "更新进度", log_finding: "记一笔",
	set_focus_contract: "只选当前一个点", verify_focus_contract: "核实这个点是否闭环",
	set_reasoning_audit: "检查思考盲区", set_true_intent: "确认真正要解决什么",
	get_executor_transcript: "看它说了啥", remember: "记住项目经验", remember_user: "记住用户偏好",
};
const toolCN = (n) => TOOL_CN[n] || "调用扩展工具";

function handle(e) {
  // SSE 是全局通道；旧会话关闭时迟到的监督事件不能污染刚创建的新会话。
  if (e.runToken && e.runToken !== activeRunToken) return;
  switch (e.kind) {
    case "supervisor":
      if (e.sub === "text") {
        const text = typeof e.text === "string" ? e.text : "";
        if (!text) break; // 空增量不能被 += 隐式转成 "null" / "undefined"
        (supMsg ||= el("msg")).textContent += text;
        if (atBottom(supFeed)) supFeed.scrollTop = supFeed.scrollHeight;
      }
      else if (e.sub === "tool") { supMsg = null; el("act", toolCN(e.text)); }
      else if (e.sub === "tool-result") { supMsg = null; el("act", toolCN(e.text) + " · 查过了"); }
      else if (e.sub === "turn") {
        supMsg = null; el("rule"); el("act", e.text);
        if ((e.text || "").startsWith("要做的：") && !embeddedThread) document.title = `${e.text.slice(4, 28)} · Arova`;
      }
      else if (e.sub === "suggest") { supMsg = null; const d = el("suggest"); d.innerHTML = "<b>我的建议</b>"; d.append(e.text || ""); }
      break;
    case "drive": { supMsg = null; el("rule"); const d = el("suggest"); d.innerHTML = `<b>${e.round === 0 ? "开工前先把方向对齐" : `让它照建议重做（第 ${e.round} 次）`}</b>`; break; }
    case "state": renderState(e.state); break;
    case "objective": $("life").textContent = e.status === "reached" ? "搞定，可以接着来" : "卡住了，等你看看"; renderState(e.state); el("rule"); break;
    case "done": $("life").textContent = "停了"; renderState(e.state); break;
    case "log":
      // 旧版会话历史里可能保存了“固定 4 轮后停手”。该机制已废弃，恢复历史时不能继续把它显示成当前规则。
      if (e.level === "warn" && !/已自动重做\s*4\s*轮仍未达标，停手等你介入/.test(e.text || "")) { supMsg = null; el("act", "⚠ " + (e.text || "")); }
      break;
    case "history-changed": onHistoryChanged(e.cwd); break;
    case "queue-snapshot": onQueueChanged(e.queueId, e.snapshot, e.stats); break;
    case "queue-item":
    case "queue-rate-limit":
    case "queue-needs-attention": onQueueChanged(e.queueId); break;
    case "term": if (term) { term.write(e.data || ""); noteTermActivity(); } break;
    case "term-reset": if (term) term.reset(); break;
    case "loop": handleLoop(e); break;
    case "queue": renderQueue(e.items || []); break;
  }
}
function handleLoop(e) {
  supMsg = null;
  if (e.sub === "discover-start") { el("rule"); el("act", "在看这个项目里有什么活要干…"); }
  else if (e.sub === "discovered") el("act", `找到 ${e.added} 件要干的（一共 ${e.pending} 件待办）`);
  else if (e.sub === "goal-start") { el("rule"); const d = el("suggest"); d.innerHTML = `<b>第 ${e.index}/${e.total} 件</b>`; d.append(" " + e.goal); $("life").textContent = `干活中 · 第 ${e.index}/${e.total} 件`; }
  else if (e.sub === "goal-done") el("act", e.status === "done" ? "搞定 ✓" : "卡住了，先放收件箱");
  else if (e.sub === "round-done") { el("rule"); el("act", `这批结束：搞定 ${e.done} 件，卡住 ${e.blocked} 件，保留待办 ${e.paused || 0} 件。我没帮你提交，你过一眼。`); $("life").textContent = "这批结束了"; }
}
function renderQueue(items) {
  const box = $("qitems");
  box.innerHTML = "";
  for (const it of items) {
    const s = document.createElement("span");
    s.className = "qitem " + it.status;
    s.textContent = (it.status === "done" ? "✓ " : it.status === "blocked" ? "⚠ " : "○ ") + it.goal;
    s.title = it.goal;
    box.appendChild(s);
  }
}
function renderState(s) {
  const p = s.progress ?? 0;
  $("progress").textContent = p + "%";
  $("barfill").style.width = p + "%";
  const gate = $("gate");
  const pass = s.completed || s.lastTestPassed;
  gate.className = "gate" + (pass ? " pass" : "");
  gate.textContent = s.completed ? "搞定" : s.lastTestPassed ? "测过了 ✓" : "还在核对";
}
new EventSource("/events").onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch {} };

async function restoreSupervisorHistory(sessionId) {
  if (!current || !sessionId) return;
  try {
    const r = await fetch(`/supervisor-history?cwd=${encodeURIComponent(current)}&id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!r.ok) return;
    const history = await r.json();
    supFeed.innerHTML = "";
    supMsg = null;
    if (history.truncated) el("act", `监督历史较长，先显示最近 ${history.events.length} 条`);
    for (const event of history.events || []) handle(event);
    supMsg = null;
    el("rule");
    el("act", "监督记录已恢复 · 下面继续跟进");
  } catch {}
}

// 思维链不是“信我就行”的绿灯：轮询执行端落下的结构化决策轨迹，在右栏可展开审计。
let thinkingTimer = null, thinkingSeen = "", thinkingEpoch = 0, snapshotSince = 0;
function snapshotIsCurrent(updatedAt) {
  const time = Date.parse(updatedAt || "");
  return Number.isFinite(time) && time >= snapshotSince;
}
function textRow(label, value, cls = "") {
  if (!value) return null;
  const row = document.createElement("div"); row.className = "tc-row " + cls;
  const b = document.createElement("b"); b.textContent = label;
  const v = document.createElement("div"); v.textContent = value;
  row.append(b, v); return row;
}
function renderThinkingTrace(d) {
  if (!d || d.updatedAt === thinkingSeen) return;
  thinkingSeen = d.updatedAt || JSON.stringify(d);
  clearEmpty();
  let card = $("thinkingCard");
  if (!card) { card = document.createElement("details"); card.id = "thinkingCard"; card.open = true; supFeed.prepend(card); }
  card.className = `thinking-card ${d.status || "pending"}`;
  card.innerHTML = "";
  const names = { pending: "正在形成思考依据", focused: "单点边界已锁定", blocked: "思考门已拦截", rejected: "思维图未通过", approved: "思考依据已通过" };
  const sum = document.createElement("summary"); sum.textContent = `思考轨迹 · ${names[d.status] || d.status}`;
  const body = document.createElement("div"); body.className = "tc-body";
  if (d.reason) body.append(textRow("为什么", d.reason, "tc-reason"));
  if (d.focus) {
    body.append(textRow("这轮只做", d.focus.point));
    body.append(textRow("第一性原理", d.focus.firstPrinciple));
    body.append(textRow("最少变量", Array.isArray(d.focus.variables) ? d.focus.variables.join(" · ") : ""));
    body.append(textRow("计算 / 判定", d.focus.calculation));
    body.append(textRow("输出", d.focus.output));
    body.append(textRow("基线", d.focus.baseline));
    body.append(textRow("闭环标准", d.focus.doneWhen));
    body.append(textRow("明确不做", Array.isArray(d.focus.notDoing) ? d.focus.notDoing.join("；") : ""));
    body.append(textRow("扩张触发", d.focus.nextTrigger));
  }
  body.append(textRow("中心问题", d.central || d.task));
  body.append(textRow("当前结论", d.conclusion));
  body.append(textRow("选用框架", d.framework));
  if (Array.isArray(d.branches) && d.branches.length) {
    const wrap = document.createElement("div"); wrap.className = "tc-row";
    const b = document.createElement("b"); b.textContent = "拆解维度";
    const ul = document.createElement("ul"); ul.className = "tc-list";
    for (const x of d.branches) { const li = document.createElement("li"); li.textContent = x.dimension + (x.unknowns ? ` · 未知：${x.unknowns}` : ""); ul.appendChild(li); }
    wrap.append(b, ul); body.appendChild(wrap);
  }
  if (Array.isArray(d.verification) && d.verification.length) {
    const wrap = document.createElement("div"); wrap.className = "tc-row";
    const b = document.createElement("b"); b.textContent = "假设怎么验的";
    const ul = document.createElement("ul"); ul.className = "tc-list";
    for (const x of d.verification) { const li = document.createElement("li"); li.textContent = `${x.assumption} → ${x.result}`; li.title = x.method || ""; ul.appendChild(li); }
    wrap.append(b, ul); body.appendChild(wrap);
  }
  if (d.checks) body.append(textRow("自动校验", `${d.checks.supportingEdges} 条结论支撑 · ${d.checks.assumptions} 条假设 · ${d.checks.contradictions} 个矛盾`));
  card.append(sum, body);
}
async function pollThinking(epoch) {
  if (!current || !mode || epoch !== thinkingEpoch) return;
  try {
    const r = await fetch(`/thinking/latest?cwd=${encodeURIComponent(current)}&run=${encodeURIComponent(activeRunToken)}`, { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      // latest.json 属于项目，不天然属于当前会话。新运行开始前的快照一律不能显示。
      if (epoch === thinkingEpoch && snapshotIsCurrent(d.updatedAt)) renderThinkingTrace(d);
    }
  } catch {}
  try {
    const r = await fetch(`/context/latest?cwd=${encodeURIComponent(current)}&run=${encodeURIComponent(activeRunToken)}`, { cache: "no-store" });
    if (r.ok) {
      const c = await r.json();
      if (epoch !== thinkingEpoch || !snapshotIsCurrent(c.updatedAt)) return;
      const label = c.status === "compacting" ? "上下文压缩中…" : c.status === "compacted" ? "上下文已压缩" : c.status === "error" ? "压缩失败" : c.percent != null ? `上下文 ${Math.round(c.percent)}%` : "";
      $("contextUsage").textContent = label;
      $("contextUsage").title = c.message || (c.tokens != null ? `${c.tokens} / ${c.contextWindow} tokens` : "");
    }
  } catch {}
}
function startThinkingTrace() {
  clearInterval(thinkingTimer);
  thinkingSeen = "";
  snapshotSince = Date.now();
  const epoch = ++thinkingEpoch;
  pollThinking(epoch);
  thinkingTimer = setInterval(() => pollThinking(epoch), 1200);
}

// 拖文件到窗口别处时，别让 Electron 导航到 file:// 把 app 冲掉
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => e.preventDefault());

// ============ 终端 ============
let term = null, fit = null, ws = null, ro = null, mode = null;
let fitPending = false, lastW = 0, lastH = 0;

// —— 启动遮罩：pi 冷启动那坨噪音藏在优雅加载态后面，输出稳定后淡出并清屏，露出干净提示符 ——
let booting = false, bootTimer = null, bootHardTimer = null;
function startBoot(resume) {
  booting = true;
  const b = $("termBoot");
  $("bootSub").textContent = current || "";
  b.hidden = false; b.classList.remove("fading");
  clearTimeout(bootHardTimer);
  // 续接会话：--continue 会立刻回放整段历史，终端持续刷屏，静默判定会被一直推迟。
  // 用更短的硬兜底放行，别让遮罩挂到 8s（那正是"接着聊后打不了字"的观感来源）。
  bootHardTimer = setTimeout(finishBoot, resume ? 2500 : 8000);
}
function noteTermActivity() {
  if (!booting) return;
  clearTimeout(bootTimer);
  bootTimer = setTimeout(finishBoot, 1000); // 输出静默 1s = 启动完成
}
function finishBoot() {
  if (!booting) return;
  booting = false;
  clearTimeout(bootTimer); clearTimeout(bootHardTimer);
  // 别 clear！那会连 pi 自己画的 TUI（banner/输入框）一起抹掉，而 pi 不会自动重画 → 一片空白。
  // 只强制重新适配尺寸：pi 收到 resize 会重排它的界面，如实显示。噪音已被遮罩挡过视觉冲击期。
  lastW = lastH = 0;
  scheduleFit();
  try { term && term.scrollToBottom(); } catch {}
  const b = $("termBoot");
  b.classList.add("fading");
  setTimeout(() => { b.hidden = true; b.classList.remove("fading"); }, 240);
  try { term && term.focus(); } catch {} // 遮罩散去立刻把焦点交给终端，否则续接后要手点一下才能打字
}
function scheduleFit() {
  if (fitPending || !fit || !term) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    const t = $("term");
    const w = t.clientWidth, h = t.clientHeight;
    if (w < 24 || h < 24) return;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    try { fit.fit(); } catch {}
    sendResize();
  });
}
// 终端主题跟随当前设计令牌（明暗切换时也用它更新已开的终端）
function termTheme() {
  const cs = getComputedStyle(document.body);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  const isLight = (v("--bg", "#212121").toLowerCase().startsWith("#ff"));
  return {
    background: v("--bg", "#212121"),
    foreground: v("--t1", "#ffffff"),
    cursor: v("--t1", "#ffffff"),
    selectionBackground: isLight ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.16)",
  };
}
function makeTerminal(resume) {
  $("term").hidden = false;
  lastW = lastH = 0;
  term = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 12, cursorBlink: true,
    theme: termTheme(),
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($("term"));
  // Electron 的 iframe 焦点链偶尔会把 Escape 留在浏览器层；Pi 原生用 Esc 取消，
  // 因此这里直接把控制字符送入同一条 PTY 通道，不能依赖 xterm 的默认键盘分发。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      sendTerminalInput("\x1b");
      return false; // 已手动发送，避免 xterm 再发送一次
    }
    // 浏览器/xterm 常把 Shift+Enter 降级成普通 \r，Pi 就会误提交。
    // Pi 原生约定用 Kitty 键盘序列区分它：\x1b[13;2u = Shift+Enter，插入换行。
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      sendTerminalInput("\x1b[13;2u");
      return false;
    }
    return true;
  });
  scheduleFit();
  ro = new ResizeObserver(scheduleFit);
  ro.observe($("term").parentElement || $("term"));
  addEventListener("resize", scheduleFit);
  startBoot(resume);
  const t = $("term");
  t.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  t.addEventListener("drop", onTermDrop);
}
function fileBridge() {
  // 历史会话在 iframe 内。新版 preload 会注入子 frame；若某个 Chromium
  // 时序下尚未注入，仍可复用同源父窗口的桥接，不让一个历史页卡死拖放。
  return window.gmapi || (window.parent !== window ? window.parent.gmapi : null);
}
async function droppedPath(file) {
  const bridge = fileBridge();
  if (bridge?.pathForFile) { const p = bridge.pathForFile(file); if (p) return { path: p, copied: false }; }
  // Electron 新版已删除 File.path。拿不到绝对路径时不能用 file.name 冒充，否则相对路径会悄悄指向错误文件。
  if (file.path) return { path: file.path, copied: false };
  // 兜底保留文件内容。Pi 要的是可读的绝对路径；给临时副本比直接阻断历史会话更可靠。
  if (bridge?.materializeDroppedFile && file.size <= 128 * 1024 * 1024) {
    try {
      const p = await bridge.materializeDroppedFile(file.name, await file.arrayBuffer());
      if (p) return { path: p, copied: true };
    } catch {}
  }
  return { path: "", copied: false };
}
async function onTermDrop(e) {
  e.preventDefault(); e.stopPropagation();
  if (mode !== "live") return;
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const resolved = await Promise.all(files.map(droppedPath));
  const paths = resolved.map((item) => item.path).filter(Boolean);
  if (paths.length !== files.length) {
    term && term.write("\r\n\x1b[33m[没能读取拖入文件的完整路径，请重启新版应用后再试]\x1b[0m\r\n");
    term && term.focus();
    return;
  }
  const text = paths.map((p) => /\s/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p).join(" ");
  if (resolved.some((item) => item.copied)) term && term.write("\r\n\x1b[90m[原路径不可用，已使用安全临时副本]\x1b[0m\r\n");
  // 历史会话会先恢复监督记录，PTY 可能还没接通。和键盘输入走同一缓冲，连接后按原顺序补发，不能静默丢路径。
  if (text) { sendTerminalInput(text + " "); term && term.focus(); }
}
function sendResize() { if (mode === "live" && ws && ws.readyState === 1 && term) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); }

// ============ 项目侧栏 + 历史 ============
let projects = [], current = null;
let projectsLoadState = "loading";
let projectsRetryTimer = null;

// /projects 只返回轻量项目元数据。添加、移除或刷新项目时，不能用它直接
// 覆盖前端数组，否则其他项目已加载的历史、待办和队列会在页面上瞬间消失。
function mergeProjectSnapshots(nextProjects, previousProjects = projects) {
  const previous = new Map(previousProjects.map((p) => [p.path, p]));
  return nextProjects.map((p) => ({
    ...p,
    history: previous.get(p.path)?.history || [],
    pending: previous.get(p.path)?.pending || 0,
    queues: previous.get(p.path)?.queues || [],
  }));
}

// 服务刚重启、窗口刚恢复时，首次请求可能比本地服务的项目接口早一点到达。
// 此时不能把“暂时没读到”伪装成“没有项目”，更不能清掉内存中的已加载列表。
async function loadProjects(attempt = 0) {
  projectsLoadState = attempt ? "retrying" : "loading";
  renderSidebar();
  try {
    const r = await fetch("/projects", { cache: "no-store" });
    if (!r.ok) throw new Error(`projects ${r.status}`);
    const body = await r.json();
    if (!Array.isArray(body.projects)) throw new Error("invalid projects response");
    // /projects 是首屏轻量接口；已展开项目的历史继续留在内存，不因刷新而闪回空白。
    projects = mergeProjectSnapshots(body.projects);
    projectsLoadState = "ready";
    if (projectsRetryTimer) clearTimeout(projectsRetryTimer);
    projectsRetryTimer = null;
    renderSidebar();
  } catch {
    if (attempt < 4) {
      projectsLoadState = "retrying";
      renderSidebar();
      const delay = [200, 500, 1000, 2000][attempt];
      setTimeout(() => void loadProjects(attempt + 1), delay);
      return;
    }
    projectsLoadState = "error";
    renderSidebar();
    // 后端升级/重启时间超过首轮退避时也不能永远停在“项目消失”。保留现有列表并后台自愈。
    if (!projectsRetryTimer) projectsRetryTimer = setTimeout(() => {
      projectsRetryTimer = null;
      void loadProjects(4);
    }, 10000);
  }
}
// 相对时间："7 分 / 17 小时 / 2 天 / 1 周"（像 Claude 侧栏）
function fmtRel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} 分`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天`;
  return `${Math.floor(s / (7 * 86400))} 周`;
}

const SIDE_SHOW = 5; // 每个项目默认露几条历史，多的收进"展开显示"
const expanded = new Set();

function renderSidebar() {
  const box = $("projList");
  box.innerHTML = "";
  if (!projects.length) {
    const d = document.createElement("div");
    d.className = "side-empty";
    if (projectsLoadState === "ready") d.innerHTML = "还没有项目。<br>点上面的 ＋，把一个文件夹加进来就能开工。";
    else if (projectsLoadState === "error") d.innerHTML = "项目列表暂时没加载出来。<br>正在保留本地数据，请稍后重新打开应用。";
    else d.textContent = "正在恢复项目列表…";
    box.appendChild(d);
    return;
  }
  const visibleCwd = threadCwd();
  const visibleSession = activeThreadSession();
  for (const p of projects) {
    const g = document.createElement("div");
    g.className = "pgroup";
    // 项目名 = 分组标题，点开项目主页；pi 只在用户明确选择行动后启动。
    const h = document.createElement("div");
    h.className = "pname" + (visibleCwd === p.path ? " sel" : "");
    h.title = p.path + "\n点击查看项目";
    const nm = document.createElement("span");
    nm.className = "pn-label";
    nm.textContent = p.name;
    nm.onclick = () => selectProject(p.path);
    const rm = document.createElement("span");
    rm.className = "pn-remove";
    rm.textContent = "×";
    rm.title = "从列表移除（不删项目文件）";
    rm.onclick = (ev) => { ev.stopPropagation(); removeProject(p.path); };
    h.append(nm, rm);
    g.appendChild(h);
    // 项目下嵌套历史
    const hist = p.history || [];
    const show = expanded.has(p.path) ? hist : hist.slice(0, SIDE_SHOW);
    for (const it of show) {
      const r = document.createElement("div");
      r.className = "hrow " + it.status + (it.session && it.session === visibleSession && p.path === visibleCwd ? " active" : "");
      r.innerHTML = `<span class="g"></span><span class="t"></span>`;
      r.querySelector(".g").textContent = (it.status === "running" ? "● " : it.status === "blocked" ? "⚠ " : "") + it.goal;
      r.querySelector(".t").textContent = it.status === "running" ? "进行中" : fmtRel(it.time);
      r.title = (it.notes || []).join("\n") || it.goal;
      r.onclick = () => openHistoryItem(p.path, it);
      g.appendChild(r);
    }
    if (hist.length > SIDE_SHOW) {
      const e = document.createElement("div");
      e.className = "expand";
      e.textContent = expanded.has(p.path) ? "收起" : "展开显示";
      e.onclick = () => {
        expanded.has(p.path) ? expanded.delete(p.path) : expanded.add(p.path);
        renderSidebar();
      };
      g.appendChild(e);
    }
    box.appendChild(g);
  }
}
const fmtT = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const day = sameDay ? "今天" : d.toDateString() === yest.toDateString() ? "昨天" : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// 点侧栏项目先进入轻量项目主页，避免打开应用时自动拉起昂贵的 pi 进程。
function selectProject(path) {
  if (mode || activeThreadView !== "main") {
    return requestThread(path);
  }
  showHome(path);
}
// 项目主页（历史 + 两个开跑按钮）。走"结束，回项目"或添加新项目时进。
function showHome(path) {
  if (mode) stopRun();
  current = path;
  localStorage.setItem("gm.proj", path);
  renderSidebar();
  const p = projects.find((x) => x.path === path);
  $("welcome").hidden = true;
  $("projHome").hidden = false;
  $("home").hidden = false;
  $("runView").hidden = true;
  $("queue").hidden = true;
  $("statusBar").hidden = true;
  $("rechoose").hidden = true;
  $("cwd").textContent = "";
  $("life").classList.remove("on");
  $("projName").textContent = p ? p.name : path.split("/").pop();
  $("projPath").textContent = path;
  $("life").textContent = "看看想干啥";
  loadHistory(path);
  loadQueues(path);
}
async function loadHistory(path) {
  const list = $("histList");
  const requestVersion = (historyRequestVersion.get(path) || 0) + 1;
  historyRequestVersion.set(path, requestVersion);
  try {
    const r = await fetch(`/history?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`history ${r.status}`);
    const h = await r.json();
    if (historyRequestVersion.get(path) !== requestVersion) return; // 旧请求晚回来，不能覆盖更新状态
    // 只有进入该项目后才把历史填进侧栏；其它项目保持首屏轻量状态。
    const project = projects.find((p) => p.path === path);
    if (project) { project.history = h.entries || []; project.pending = h.pending || 0; renderSidebar(); }
    if (path !== current || $("projHome").hidden) return;
    $("pendCount").textContent = h.pending ? `还有 ${h.pending} 件等着干` : "";
    const next = document.createDocumentFragment();
    if (!h.entries.length) {
      const d = document.createElement("div");
      d.className = "hist-empty";
      d.textContent = "这个项目还没干过活。点上面开始。";
      next.appendChild(d);
    } else {
      for (const it of h.entries) {
        const d = document.createElement("div");
        d.className = "h-item" + (it.status === "blocked" ? " blocked" : it.status === "open" ? " open" : it.status === "running" ? " running" : "");
        d.innerHTML = `<span class="st"></span><span class="g"></span><span class="t"></span>`;
        d.querySelector(".st").textContent = it.status === "done" ? "✓" : it.status === "blocked" ? "⚠" : it.status === "running" ? "●" : "○";
        d.querySelector(".g").textContent = it.goal;
        d.querySelector(".t").textContent = it.status === "running" ? "进行中" : fmtT(it.time);
        d.title = (it.notes || []).join("\n") || it.goal;
        d.style.cursor = "pointer";
        d.onclick = () => openHistoryItem(path, it);
        next.appendChild(d);
      }
    }
    // 新数据完整到位后一次替换，避免状态更新时先清空再闪回。
    list.replaceChildren(next);
  } catch {
    if (path === current && !$("projHome").hidden) $("pendCount").textContent = "";
  }
}
const historyRefreshTimers = new Map();
const historyRequestVersion = new Map();
// 历史变了直接读该项目：不再先绕行 /projects。高频状态事件合并为一次刷新。
function onHistoryChanged(cwd) {
  const project = projects.find((p) => p.path === cwd);
  if (cwd !== current && !project?.history?.length) return; // 懒加载项目没有展开过历史，无需为它阻塞 UI
  if (historyRefreshTimers.has(cwd)) return;
  historyRefreshTimers.set(cwd, setTimeout(() => {
    historyRefreshTimers.delete(cwd);
    void loadHistory(cwd);
  }, 50));
}

// ============ 渐进式批处理队列 ============
const queueRefreshTimers = new Map();
const queueRequestVersion = new Map();
const expandedQueues = new Set();

const QUEUE_STATE_CN = {
  draft: "草稿", ready: "待开始", running: "运行中", pausing: "正在暂停", paused: "已暂停",
  needs_attention: "需要处理", cancelling: "正在取消", cancelled: "已取消", completed: "已完成",
  completed_with_waivers: "完成（含人工放行）",
};
const ITEM_STATE_CN = {
  pending: "等待", leased: "已领取", running: "执行中", validating: "校验中", reviewing: "复核中",
  retry_wait: "等待重试", verified: "已验证", blocked: "已阻塞", waived: "人工放行", cancelled: "已取消",
};
const QUEUE_TERMINAL = new Set(["cancelled", "completed", "completed_with_waivers"]);

async function loadQueues(path) {
  const version = (queueRequestVersion.get(path) || 0) + 1;
  queueRequestVersion.set(path, version);
  try {
    const r = await fetch(`/queues?cwd=${encodeURIComponent(path)}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`queues ${r.status}`);
    const body = await r.json();
    if (queueRequestVersion.get(path) !== version) return;
    const project = projects.find((p) => p.path === path);
    if (project) project.queues = Array.isArray(body.queues) ? body.queues : [];
    if (path === current && !$("projHome").hidden) renderProjectQueues();
  } catch (error) {
    if (path === current && !$("projHome").hidden) showQueueError("队列暂时没加载出来，请稍后再试");
  }
}

function onQueueChanged(queueId, snapshot, stats) {
  let path = projects.find((p) => (p.queues || []).some((q) => q.id === queueId))?.path;
  if (!path && current && !$("projHome").hidden) path = current;
  if (!path) return;
  const project = projects.find((p) => p.path === path);
  if (snapshot && project) {
    const old = (project.queues || []).find((q) => q.id === queueId);
    const summary = { ...snapshot, items: undefined, stats: stats || old?.stats || {} };
    project.queues = [summary, ...(project.queues || []).filter((q) => q.id !== queueId)];
    if (path === current) renderProjectQueues();
  }
  if (queueRefreshTimers.has(path)) return;
  queueRefreshTimers.set(path, setTimeout(() => {
    queueRefreshTimers.delete(path);
    void loadQueues(path);
  }, 80));
}

function showQueueError(message) {
  const box = $("projectQueues");
  if (!box) return;
  let d = box.querySelector(".batch-error");
  if (!d) { d = document.createElement("div"); d.className = "batch-error"; box.prepend(d); }
  d.textContent = message;
}

function queueButton(text, action, cls = "") {
  const button = document.createElement("button");
  button.className = `batch-btn${cls ? ` ${cls}` : ""}`;
  button.textContent = text;
  button.onclick = (event) => { event.stopPropagation(); void action(button); };
  return button;
}

function renderProjectQueues() {
  const box = $("projectQueues");
  box.replaceChildren();
  const project = projects.find((p) => p.path === current);
  const queues = [...(project?.queues || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  if (!queues.length) {
    const d = document.createElement("div"); d.className = "batch-empty";
    d.textContent = "几百条同类任务，可以拆成一条一条的独立队列执行。";
    box.appendChild(d); return;
  }
  for (const queue of queues) {
    const stats = queue.stats || {};
    const card = document.createElement("article");
    card.className = `batch-card ${queue.state || ""}`;
    const top = document.createElement("div"); top.className = "batch-top";
    const title = document.createElement("div"); title.className = "batch-title"; title.textContent = queue.title || "未命名队列"; title.title = queue.id;
    const state = document.createElement("span"); state.className = `batch-state ${queue.state || ""}`; state.textContent = QUEUE_STATE_CN[queue.state] || queue.state;
    top.append(title, state);

    const meta = document.createElement("div"); meta.className = "batch-meta";
    const completed = (stats.verified || 0) + (stats.waived || 0);
    const pieces = [`${completed}/${stats.total || 0} 条`, `验证 ${stats.verified || 0}`, `运行 ${stats.running || 0}`, `重试 ${stats.retryWait || 0}`, `阻塞 ${stats.blocked || 0}`];
    if (queue.retryAt && Date.parse(queue.retryAt) > Date.now()) pieces.push(`限流冷却至 ${new Date(queue.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
    for (const text of pieces) { const span = document.createElement("span"); span.textContent = text; meta.appendChild(span); }
    const progress = document.createElement("div"); progress.className = "batch-progress";
    const fill = document.createElement("i"); fill.style.width = `${Math.max(0, Math.min(100, Number(stats.progress || 0)))}%`; progress.appendChild(fill);
    const controls = document.createElement("div"); controls.className = "batch-controls";
    if (queue.state === "ready") controls.appendChild(queueButton("开始", () => queueAction(queue.id, "start")));
    if (queue.state === "running") {
      controls.appendChild(queueButton("暂停（当前条收尾）", () => queueAction(queue.id, "pause", { mode: "drain" })));
      controls.appendChild(queueButton("立即暂停", () => queueAction(queue.id, "pause", { mode: "immediate" })));
    }
    if (queue.state === "paused") controls.appendChild(queueButton("继续", () => queueAction(queue.id, "resume")));
    if (queue.state === "needs_attention") controls.appendChild(queueButton("重试可恢复项", () => queueAction(queue.id, "resume")));
    if (!QUEUE_TERMINAL.has(queue.state) && queue.state !== "cancelling") controls.appendChild(queueButton("取消整批", () => queueAction(queue.id, "cancel"), "danger"));
    controls.appendChild(queueButton(expandedQueues.has(queue.id) ? "收起条目" : "查看条目", () => {
      expandedQueues.has(queue.id) ? expandedQueues.delete(queue.id) : expandedQueues.add(queue.id);
      renderProjectQueues();
    }));

    if (!QUEUE_TERMINAL.has(queue.state)) {
      const parallel = document.createElement("label"); parallel.className = "parallel";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = Number(queue.configuredConcurrency || 1) > 1;
      const label = document.createElement("span"); label.textContent = "并行";
      const select = document.createElement("select");
      for (const n of [2, 3, 4]) { const option = document.createElement("option"); option.value = String(n); option.textContent = String(n); select.appendChild(option); }
      select.value = String(Math.max(2, Number(queue.configuredConcurrency || 2)));
      select.disabled = !check.checked;
      const update = () => queueAction(queue.id, "parallel", { enabled: check.checked, concurrency: Number(select.value) });
      check.onchange = () => { select.disabled = !check.checked; void update(); };
      select.onchange = () => void update();
      parallel.append(check, label, select);
      const effective = document.createElement("span"); effective.textContent = `实际 ${queue.effectiveConcurrency || 1}`; parallel.appendChild(effective);
      controls.appendChild(parallel);
    }
    card.append(top, meta, progress, controls);
    box.appendChild(card);
    if (expandedQueues.has(queue.id)) void renderQueueDetails(queue.id, card);
  }
}

async function renderQueueDetails(queueId, card) {
  const loading = document.createElement("div"); loading.className = "batch-detail"; loading.textContent = "正在读取条目…"; card.appendChild(loading);
  try {
    const r = await fetch(`/queues/${encodeURIComponent(queueId)}?cwd=${encodeURIComponent(current)}&limit=200`, { cache: "no-store" });
    if (!r.ok) throw new Error(`queue ${r.status}`);
    const body = await r.json();
    if (!expandedQueues.has(queueId) || !card.isConnected) return;
    loading.replaceChildren();
    const priority = { blocked: 0, running: 1, validating: 1, reviewing: 1, retry_wait: 2, pending: 3, leased: 3, waived: 4, cancelled: 5, verified: 6 };
    const items = [...(body.snapshot?.items || [])].sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));
    for (const item of items.slice(0, 40)) {
      const row = document.createElement("div"); row.className = `batch-item ${item.status}`;
      const key = document.createElement("span"); key.className = "item-key"; key.textContent = item.sourceKey || item.id; key.title = item.lastError?.message || item.sourceKey || item.id;
      const status = document.createElement("span"); status.className = "item-status"; status.textContent = ITEM_STATE_CN[item.status] || item.status;
      row.append(key, status);
      if (item.status === "blocked" || item.status === "waived") row.appendChild(queueButton("重试", () => queueAction(queueId, `items/${item.id}/retry`)));
      if (["pending", "retry_wait", "blocked"].includes(item.status)) row.appendChild(queueButton("放行", async () => {
        const reason = prompt("请写明人工放行原因（至少 4 个字）", "已人工核对，接受该条未完成");
        if (reason) await queueAction(queueId, `items/${item.id}/waive`, { reason });
      }));
      loading.appendChild(row);
    }
    if (items.length > 40) { const more = document.createElement("div"); more.className = "batch-more"; more.textContent = `还有 ${items.length - 40} 条；当前优先显示运行、阻塞和待重试项。`; loading.appendChild(more); }
  } catch {
    loading.textContent = "条目读取失败，稍后再展开。";
  }
}

async function queueAction(queueId, action, body = {}) {
  const path = current;
  try {
    const r = await fetch(`/queues/${encodeURIComponent(queueId)}/${action}?cwd=${encodeURIComponent(path)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: path, ...body }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(result.error || `请求失败 ${r.status}`);
    onQueueChanged(queueId, result.snapshot);
  } catch (error) { showQueueError(error instanceof Error ? error.message : String(error)); }
}

function parseQueueItems(raw) {
  const text = raw.trim();
  if (!text) throw new Error("至少需要一条待处理记录");
  let values;
  if (text.startsWith("[")) {
    values = JSON.parse(text);
    if (!Array.isArray(values) || !values.length) throw new Error("JSON 必须是非空数组");
  } else values = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((value) => ({ value }));
  if (values.length > 10000) throw new Error("单个队列最多 10000 条，请拆成多批");
  return values.map((value, index) => {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
    const explicit = typeof object.sourceKey === "string" ? object.sourceKey : typeof object.source_key === "string" ? object.source_key : "";
    const key = explicit || String(object.id ?? object.key ?? object.name ?? object.value ?? `第 ${index + 1} 条`).slice(0, 200);
    const payload = "payload" in object && explicit ? object.payload : object;
    return { sourceKey: key, payload };
  });
}

async function createQueueFromForm() {
  const error = $("queueCreateError"); error.textContent = "";
  const submit = $("queueCreateSubmit"); submit.disabled = true;
  try {
    const title = $("queueTitle").value.trim();
    const primaryGoal = $("queueGoal").value.trim();
    const itemPromptTemplate = $("queuePrompt").value.trim();
    if (!primaryGoal) throw new Error("请写清这一批的最终目标");
    if (!itemPromptTemplate) throw new Error("请写清每条记录怎么处理");
    const items = parseQueueItems($("queueItems").value);
    const contract = {
      primaryGoal,
      requirements: ["每次只处理当前一条记录", "不得把其它条目的结论混入当前结果", "结论必须可验证；不能完成时明确报告阻塞原因"],
      skills: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      itemPromptTemplate,
      deterministicChecks: [{ id: "no-unresolved", type: "require-no-unresolved" }],
      semanticReviewPolicy: $("queueReview").value,
      maxSemanticRedos: Math.max(0, Math.floor(Number($("queueSemanticRedos").value || 0))),
      maxTransientRetries: Math.max(0, Math.floor(Number($("queueTransientRetries").value || 0))),
      itemTimeoutMs: Math.max(0, Math.floor(Number($("queueItemTimeoutMinutes").value || 0) * 60_000)),
    };
    const r = await fetch("/queues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      cwd: current, title: title || primaryGoal.slice(0, 40), contract, items,
      parallelEnabled: $("queueParallel").checked, concurrency: Number($("queueConcurrency").value),
    }) });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(result.error || `创建失败 ${r.status}`);
    $("queueCreate").hidden = true;
    $("queueTitle").value = ""; $("queueGoal").value = ""; $("queuePrompt").value = ""; $("queueItems").value = "";
    await loadQueues(current);
  } catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); }
  finally { submit.disabled = false; }
}

function openHistoryItem(path, it) {
  if (!it.session) {
    // 旧版/loop 记录没有可恢复的真实会话；也不制造详情中间页，直接开新会话继续处理。
    if (mode || activeThreadView !== "main") return requestThread(path);
    current = path; localStorage.setItem("gm.proj", path); renderSidebar(); startLive(); return;
  }
  // 当前已有任务，或目标会话正在后台运行：新建/聚焦内部会话容器，绝不先 stop 当前任务。
  if (mode || activeThreadView !== "main" || it.status === "running") {
    return requestThread(path, it.session);
  }
  current = path;
  localStorage.setItem("gm.proj", path);
  renderSidebar();
  startLive(it.session); // 无运行任务时直接进入，不再经过详情中间页
}
function showWelcome() {
  current = null;
  $("home").hidden = false;
  $("welcome").hidden = false;
  $("projHome").hidden = true;
  $("runView").hidden = true;
  $("queue").hidden = true;
  $("statusBar").hidden = true;
  $("rechoose").hidden = true;
  $("cwd").textContent = "";
  $("life").classList.remove("on");
  $("life").textContent = "选个项目开始";
}
async function addProjectPath(path) {
  if (!path) return;
  try {
    const r = await fetch("/projects/add", { method: "POST", body: JSON.stringify({ path }) });
    if (!r.ok) { $("addPath").placeholder = "这个路径不是文件夹，再试试"; $("addPath").value = ""; return; }
    const body = await r.json();
    projects = mergeProjectSnapshots(body.projects || []);
    $("addRow").hidden = true;
    renderSidebar();
    selectProject(path);
  } catch {}
}
async function removeProject(path) {
  try {
    const r = await fetch("/projects/remove", { method: "POST", body: JSON.stringify({ path }) });
    if (!r.ok) throw new Error(`remove project ${r.status}`);
    const body = await r.json();
    projects = mergeProjectSnapshots(body.projects || []);
    if (current === path) { current = null; localStorage.removeItem("gm.proj"); showWelcome(); }
    renderSidebar();
  } catch {}
}
async function onAddProj() {
  if (window.gmapi?.pickFolder) {
    const p = await window.gmapi.pickFolder();
    if (p) addProjectPath(p);
  } else {
    $("addRow").hidden = !$("addRow").hidden;
    if (!$("addRow").hidden) $("addPath").focus();
  }
}

// ============ 开跑 / 收工 ============
function enterRun(lifeText) {
  $("home").hidden = true;
  $("runView").hidden = false;
  $("statusBar").hidden = false;
  $("cwd").textContent = current;
  $("rechoose").hidden = false;
  $("life").textContent = lifeText;
  $("life").classList.add("on");
  supFeed.innerHTML = "";
  supMsg = null;
}
function startLive(resumeSession) {
  if (!current) return;
  const sessId = typeof resumeSession === "string" ? resumeSession : ""; // 按钮 onclick 会传 MouseEvent，归一化
  mode = "live";
  activeRunToken = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  enterRun(sessId ? "接着上次聊" : "把关中");
  supFeed.innerHTML = '<div class="empty">你一开始干活，我就在旁边帮你把关。<br>只提建议，不替你动手。</div>';
  $("execLabel").textContent = "AI 在干活 · 你随时能插手";
  makeTerminal(!!sessId);
  const runToken = activeRunToken;
  void (async () => {
    if (sessId) await restoreSupervisorHistory(sessId);
    if (mode !== "live" || activeRunToken !== runToken) return;
    if (sessId) $("life").textContent = "接着上次聊";
    connectPty(sessId, runToken);
    startThinkingTrace();
  })();
  // onData 只绑一次；断线期间的键入不再被静默吞掉——存起来，等重连成功再补发（否则表现为"能聚焦却打不了字"）
  term.onData(sendTerminalInput);
}
// 建立/重建 pty 连接。断线不再是"死终端"：会自动重连一次并把缓冲的键入补发，连不上就明确告诉用户。
let pendingInput = "";
let reconnectTried = false;
let activeSessionId = "";
function sendTerminalInput(text) {
  if (!text) return;
  if (ws && ws.readyState === 1) ws.send(text);
  else pendingInput += text; // 历史恢复/重连期间，键盘和拖入路径都不能丢
}
function connectPty(sessId, runToken) {
  const dec = new TextDecoder();
  ws = new WebSocket(`ws://${location.host}/pty?cwd=${encodeURIComponent(current)}&run=${encodeURIComponent(runToken)}${sessId ? `&session=${encodeURIComponent(sessId)}` : ""}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => { term && term.write(typeof e.data === "string" ? e.data : dec.decode(e.data)); noteTermActivity(); };
  ws.onopen = async () => {
    reconnectTried = false;
    sendResize();
    if (pendingInput) {
      const queued = pendingInput;
      try { ws.send(queued); pendingInput = ""; } catch {} // 发送失败就保留，等重连再补，文件路径也不能丢
    }
    try { term && term.focus(); } catch {}
    try {
      const r = await fetch(`/run/info?run=${encodeURIComponent(runToken)}`, { cache: "no-store" });
      if (r.ok && runToken === activeRunToken) {
        activeSessionId = (await r.json()).sessionId || "";
        if (activeSessionId) {
          if (embeddedThread) parent.postMessage({ type: "thread-session", session: activeSessionId }, location.origin);
          else { mainThreadSession = activeSessionId; renderSidebar(); }
        }
      }
    } catch {}
  };
  ws.onclose = () => {
    if (mode !== "live") return; // 用户主动结束，正常
    // pty 意外断开（后端连接初始化失败/pi 退出）→ 自动重连一次，避免"能聚焦却打不了字"的死终端
    if (!reconnectTried) {
      reconnectTried = true;
      try { term && term.write("\r\n\x1b[33m[连接断开，正在重连…]\x1b[0m\r\n"); } catch {}
      setTimeout(() => mode === "live" && runToken === activeRunToken && connectPty(sessId, runToken), 600);
    } else {
      try { term && term.write("\r\n\x1b[31m[连接没接上。点顶部\"结束，回项目\"再重进一次，或重启应用。]\x1b[0m\r\n"); } catch {}
    }
  };
}
async function startLoop() {
  if (!current) return;
  mode = "loop";
  enterRun("干活中");
  supFeed.innerHTML = '<div class="empty">AI 会自己找活、做、检查、记录。<br>你在这儿看着、拍板就行。</div>';
  $("queue").hidden = false;
  $("execLabel").textContent = "AI 自己在干 · 你看着就好";
  makeTerminal();
  startThinkingTrace();
  await fetch("/loop/start", { method: "POST", body: JSON.stringify({ cwd: current }) });
}
// 拆掉正在跑的（终端/循环/ws），不做导航。
function stopRun() {
  if (mode === "loop") fetch("/loop/stop", { method: "POST" }).catch(() => {});
  // 先解绑 onclose 再关，否则会被误当成"意外断开"触发自动重连
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  try { ro && ro.disconnect(); } catch {}
  removeEventListener("resize", scheduleFit);
  if (term) { term.dispose(); term = null; }
  ws = null; mode = null;
  activeRunToken = "";
  activeSessionId = "";
  if (!embeddedThread) mainThreadSession = "";
  clearInterval(thinkingTimer); thinkingTimer = null; thinkingSeen = "";
  thinkingEpoch++; snapshotSince = 0;
  $("contextUsage").textContent = "";
  pendingInput = ""; reconnectTried = false;
  booting = false; clearTimeout(bootTimer); clearTimeout(bootHardTimer);
  $("termBoot").hidden = true; $("termBoot").classList.remove("fading");
  $("term").hidden = true; $("term").innerHTML = "";
}
// 顶栏"结束，回项目"：收掉当前运行，回项目主页看历史，并刷新侧栏（这单可能刚记进历史）。
function endRun() {
  const c = current;
  stopRun();
  if (c) showHome(c); else showWelcome();
  loadProjects();
}

// 中间分隔条：拖动调整"把关"栏宽度，记住偏好
(function setupPaneDrag() {
  const rv = $("runView"), drag = $("paneDrag");
  const saved = parseFloat(localStorage.getItem("gm.supW"));
  if (saved >= 15 && saved <= 70) rv.style.setProperty("--sup-w", saved + "%");
  let dragging = false;
  drag.addEventListener("mousedown", (e) => {
    dragging = true; e.preventDefault();
    drag.classList.add("dragging");
    document.body.classList.add("resizing-panes");
  });
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const r = rv.getBoundingClientRect();
    let pct = ((r.right - e.clientX) / r.width) * 100; // 把关栏在右侧
    pct = Math.max(18, Math.min(66, pct)); // 夹住，别拖没
    rv.style.setProperty("--sup-w", pct.toFixed(1) + "%");
    scheduleFit(); // 终端跟着重排
  });
  addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    drag.classList.remove("dragging");
    document.body.classList.remove("resizing-panes");
    const cur = rv.style.getPropertyValue("--sup-w");
    if (cur) localStorage.setItem("gm.supW", parseFloat(cur));
    scheduleFit();
  });
})();

// —— 主题：跟随系统 / 亮 / 暗，三态循环，记住选择 ——
const THEMES = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
const THEME_NAME = { auto: "跟随系统", light: "白天模式", dark: "黑暗模式" };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  const btn = $("themeBtn");
  btn.textContent = THEME_ICON[t];
  btn.title = `主题：${THEME_NAME[t]}（点击切换）`;
  if (term) term.options.theme = termTheme(); // 已开的终端跟着换
}
function cycleTheme() {
  const cur = localStorage.getItem("gm.theme") || "auto";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  localStorage.setItem("gm.theme", next);
  applyTheme(next);
}
$("themeBtn").onclick = cycleTheme;
$("newThreadBtn").onclick = () => requestThread(threadCwd() || current);
applyTheme(localStorage.getItem("gm.theme") || "auto");

$("addProj").onclick = onAddProj;
$("addPath").addEventListener("keydown", (e) => { if (e.key === "Enter") addProjectPath($("addPath").value.trim()); });
$("btnLoop").onclick = startLoop;
$("btnLive").onclick = startLive;
$("newQueueBtn").onclick = () => {
  $("queueCreate").hidden = !$("queueCreate").hidden;
  $("queueCreateError").textContent = "";
  if (!$("queueCreate").hidden) $("queueTitle").focus();
};
$("queueCreateCancel").onclick = () => { $("queueCreate").hidden = true; $("queueCreateError").textContent = ""; };
$("queueCreateSubmit").onclick = () => void createQueueFromForm();
$("queueParallel").onchange = () => { $("queueConcurrency").disabled = !$("queueParallel").checked; };
$("queueConcurrency").disabled = true;
$("rechoose").onclick = () => activeThreadView === "main" ? endRun() : closeThreadView(activeThreadView);

(async function init() {
  if (embeddedThread) document.body.classList.add("embedded");
  else activateThreadView("main");
  if (window.gmapi) document.body.classList.add("electron");
  await loadProjects();
  const launch = launchParams;
  const launchCwd = launch.get("cwd"), launchSession = launch.get("session");
  if (launchCwd && launchSession && projects.some((p) => p.path === launchCwd)) {
    if (!embeddedThread) history.replaceState(null, "", "/");
    current = launchCwd;
    localStorage.setItem("gm.proj", launchCwd);
    renderSidebar();
    startLive(launchSession);
    return;
  }
  if (launchCwd && projects.some((p) => p.path === launchCwd)) {
    if (!embeddedThread) history.replaceState(null, "", "/");
    current = launchCwd;
    localStorage.setItem("gm.proj", launchCwd);
    renderSidebar();
    startLive();
    return;
  }
  const last = localStorage.getItem("gm.proj");
  if (last && projects.some((p) => p.path === last)) showHome(last); // 打开即恢复项目壳，不自动启动 pi
  else if (projects.length) showHome(projects[0].path);
  else showWelcome();
})();
