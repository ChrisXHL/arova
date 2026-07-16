const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("gmapi", {
	// 打开原生文件夹选择对话框，返回所选路径（取消则 null）。
	pickFolder: () => ipcRenderer.invoke("pick-folder"),
	// 取拖入文件的真实绝对路径（新版 Electron 删了 File.path，只能用 webUtils）。
	pathForFile: (file) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},
	// 某些历史 iframe/Chromium 拖放场景会丢失 File 的 native path。保留内容，
	// 落到受控临时副本后仍可把一个真实绝对路径交给 Pi，而不是直接报错中断。
	materializeDroppedFile: (name, bytes) => ipcRenderer.invoke("materialize-dropped-file", name, bytes),
});
