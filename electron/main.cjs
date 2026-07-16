// Electron 外壳：原生 Mac 窗口包住本地服务（真实 pi 终端 + 监督面板）。
// 用 Electron 自带的 Node 跑服务（零系统 node 依赖），只「链接本地 pi」。
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const PORT = process.env.PORT || "5781";
const ROOT = path.join(__dirname, "..");
const WORKDIR = process.env.GM_WORKDIR || process.cwd() || os.homedir();
let server;
let mainWindow;

// 同一份项目注册与同一端口只能由一个实例管理。第二次打开只聚焦旧窗口，避免端口竞争和重复冷启动。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

// Finder 启动的 .app 只有精简 PATH，用登录 shell 还原，子进程才找得到本地 pi/git。
function restoredPath() {
	let p = "";
	try {
		p = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 4000 }).trim();
	} catch {}
	const extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", path.join(os.homedir(), ".local/bin")];
	return [...new Set([p, process.env.PATH || "", ...extra].join(":").split(":").filter(Boolean))].join(":");
}

function startServer() {
	server = spawn(process.execPath, ["--experimental-strip-types", path.join(ROOT, "src", "server.ts")], {
		cwd: ROOT,
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PORT, WORKDIR, PATH: restoredPath() },
		stdio: "inherit",
	});
}

function waitForServer(cb, tries = 0) {
	http
		.get(`http://localhost:${PORT}/`, () => cb())
		.on("error", () => (tries > 80 ? cb(new Error("服务启动超时")) : setTimeout(() => waitForServer(cb, tries + 1), 150)));
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 960,
		title: "Arova",
		backgroundColor: "#0e0e0e",
		titleBarStyle: "hiddenInset",
		webPreferences: {
			contextIsolation: true,
			// 多会话运行在同源 iframe；让 preload 也进入子 frame，拖入文件时才能调用 webUtils.getPathForFile 取绝对路径。
			nodeIntegrationInSubFrames: true,
			preload: path.join(__dirname, "preload.cjs"),
		},
	});
	mainWindow = win;
	win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("did-finish-load", () => console.log("[electron] window loaded"));
	waitForServer((err) => {
		if (err) win.loadURL(`data:text/html,<h2 style="color:#fff;font-family:sans-serif;padding:2rem">服务启动失败：${err.message}</h2>`);
		else win.loadURL(`http://localhost:${PORT}/`);
	});
	return win;
}

ipcMain.handle("pick-folder", async () => {
	const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
		title: "选择项目文件夹",
		properties: ["openDirectory", "createDirectory"],
	});
	return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

ipcMain.handle("materialize-dropped-file", (_event, originalName, bytes) => {
	try {
		const data = Buffer.from(bytes);
		// 路径桥接失败时才走这里；限制体积以免一个误拖的镜像文件把 Electron 内存打满。
		if (!data.length || data.length > 128 * 1024 * 1024) return "";
		const safeName = path.basename(String(originalName || "dropped-file")).replace(/[^\w.\-() ]/g, "_").slice(-120) || "dropped-file";
		const dir = path.join(app.getPath("temp"), "goal-mode-pi-drops");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, `${Date.now()}-${crypto.randomUUID()}-${safeName}`);
		fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
		return target;
	} catch {
		return "";
	}
});

if (gotSingleInstanceLock) {
	app.on("second-instance", () => {
		if (!mainWindow) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
	app.whenReady().then(() => {
		startServer();
		createWindow();
		app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
	});
	app.on("window-all-closed", () => {
		// macOS 关闭最后一个窗口后仍保留 Dock 应用；服务也必须保留，
		// 否则点 Dock 重新开窗口时只能得到失联的黑屏。
		if (process.platform !== "darwin") {
			server?.kill();
			app.quit();
		}
	});
	app.on("quit", () => server?.kill());
}
