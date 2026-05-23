const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kindmd", {
  // One-shot calls
  listDir: (path) => ipcRenderer.invoke("list-dir", path),
  renderMd: (path) => ipcRenderer.invoke("render-md", path),
  renderCsv: (path) => ipcRenderer.invoke("render-csv", path),
  renderString: (raw, fallbackTitle) => ipcRenderer.invoke("render-string", raw, fallbackTitle),
  writeMd: (path, content) => ipcRenderer.invoke("write-md", path, content),
  renameFile: (oldPath, newName) => ipcRenderer.invoke("rename-file", oldPath, newName),
  saveMdAs: (payload) => ipcRenderer.invoke("save-md-as", payload),
  copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),
  openFolderInClaudeCode: (folderPath) => ipcRenderer.invoke("open-folder-in-claude-code", folderPath),
  showInFinder: (path) => ipcRenderer.invoke("show-in-finder", path),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  exportHtml: (payload) => ipcRenderer.invoke("export-html", payload),
  requestFolder: (defaultPath) => ipcRenderer.invoke("request-folder", defaultPath),
  requestFile: () => ipcRenderer.invoke("request-file"),
  getState: () => ipcRenderer.invoke("get-state"),

  // Fire-and-forget
  watchFile: (path) => ipcRenderer.send("watch-file", path),
  unwatchFile: () => ipcRenderer.send("unwatch-file"),

  // Subscriptions (return an unsubscribe function)
  onFolderOpened: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("folder-opened", h);
    return () => ipcRenderer.removeListener("folder-opened", h);
  },
  onFileOpened: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("file-opened", h);
    return () => ipcRenderer.removeListener("file-opened", h);
  },
  onFileChanged: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on("file-changed", h);
    return () => ipcRenderer.removeListener("file-changed", h);
  },
  onToggleSidebar: (cb) => {
    const h = () => cb();
    ipcRenderer.on("toggle-sidebar", h);
    return () => ipcRenderer.removeListener("toggle-sidebar", h);
  },
  onToggleToc: (cb) => {
    const h = () => cb();
    ipcRenderer.on("toggle-toc", h);
    return () => ipcRenderer.removeListener("toggle-toc", h);
  },
  onFocusSearch: (cb) => {
    const h = () => cb();
    ipcRenderer.on("focus-search", h);
    return () => ipcRenderer.removeListener("focus-search", h);
  },
});
