const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegrationInSubFrames: true,
			preload: path.join(__dirname, "..", "electron", "preload.cjs"),
		},
	});
	await win.loadURL("data:text/html,<iframe id='thread' srcdoc='<p>thread</p>'></iframe>");
	await new Promise((resolve) => setTimeout(resolve, 150));
	const exposed = await win.webContents.executeJavaScript(
		"Boolean(document.getElementById('thread').contentWindow.gmapi?.pathForFile) && Boolean(document.getElementById('thread').contentWindow.gmapi?.materializeDroppedFile)",
	);
	win.destroy();
	if (!exposed) throw new Error("preload 没有进入会话 iframe");
	console.log("✅ Electron 运行时：会话 iframe 已获得 pathForFile 桥");
	app.quit();
}).catch((err) => {
	console.error(err);
	app.exit(1);
});
