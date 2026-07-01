import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, clipboard } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import chokidar from "chokidar";

import { render } from "../src/render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let mainWindow = null;
let watcher = null;
let lastOpenedFolder = null;
let lastOpenedFile = null;

// Extensions we know how to open (markdown family + tabular files + HTML).
const SUPPORTED_EXT_RE = /\.(md|markdown|mdown|mkd|csv|tsv|html|htm)$/i;

// Pull a supported file path from process.argv if macOS delivered it that way
// instead of via the open-file event (happens with some launch invocations).
function pickArgvFile() {
  const skip = new Set(["--", "-h", "-help", "--help"]);
  for (let i = 1; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a || a.startsWith("-") || skip.has(a)) continue;
    try {
      const abs = path.resolve(a);
      if (fs.existsSync(abs) && SUPPORTED_EXT_RE.test(abs)) {
        return abs;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ----- CSV parsing -----

// Detect the most likely field separator from the first non-empty line.
function detectCsvSeparator(text) {
  const firstLineMatch = text.match(/^[^\n]+/);
  const line = firstLineMatch ? firstLineMatch[0] : "";
  const counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
  }
  let best = ",";
  let bestN = counts[","];
  for (const sep of [";", "\t", "|"]) {
    if (counts[sep] > bestN) { best = sep; bestN = counts[sep]; }
  }
  return best;
}

// Lightweight RFC 4180-ish CSV parser. Handles quoted fields, escaped quotes,
// CRLF, embedded newlines inside quotes, and a BOM at start of file.
function parseCsv(text, separator) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sep = separator || detectCsvSeparator(text);
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
      started = true;
    } else {
      if (ch === '"' && !started) { inQuotes = true; }
      else if (ch === '"') { inQuotes = true; started = true; }
      else if (ch === sep) { row.push(cur); cur = ""; started = false; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; started = false; }
      else if (ch === "\r") { /* skip — handled with following \n or EOF */ }
      else { cur += ch; started = true; }
    }
  }
  if (started || cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  // Drop any trailing fully-empty row from a final newline.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  // Normalise row widths to the widest row (pad short rows with empty strings).
  let maxWidth = 0;
  for (const r of rows) if (r.length > maxWidth) maxWidth = r.length;
  for (const r of rows) while (r.length < maxWidth) r.push("");
  return { rows, separator: sep };
}

// True when we have a live window we can deliver an event to.
function windowAlive() {
  return !!mainWindow && !mainWindow.isDestroyed();
}

// Send the cached file path to the renderer, waiting for it to be ready if
// the window is still loading. Tolerates a destroyed/closed window — the
// caller is expected to (re)create one when needed.
function deliverPendingFileToRenderer() {
  if (!windowAlive() || !lastOpenedFile) return;
  const send = () => {
    if (!windowAlive()) return;
    try {
      mainWindow.webContents.send("file-opened", lastOpenedFile);
    } catch { /* ignore — webContents may have died between checks */ }
  };
  try {
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once("did-finish-load", send);
    } else {
      send();
    }
  } catch { /* ignore */ }
}

// ----- App config -----

app.setName("kindmd");

// ----- Window -----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: "kindmd",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#F5F1E8",
    vibrancy: "sidebar",
    visualEffectState: "active",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Null the reference as soon as the window dies. Otherwise `mainWindow`
  // would point at a destroyed BrowserWindow and any later access (e.g. an
  // open-file event after the window was closed) would throw
  // "Object has been destroyed".
  mainWindow.once("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("will-navigate", (e, url) => {
    // External links open in the user's default browser, not the app shell.
    if (!url.startsWith("file://")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  Menu.setApplicationMenu(buildMenu());
}

// ----- Menu -----

function buildMenu() {
  const template = [
    {
      label: "kindmd",
      submenu: [
        { label: "About kindmd", role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit kindmd", accelerator: "Cmd+Q", role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "Cmd+O",
          click: () => openFolderDialog(),
        },
        {
          label: "Open File…",
          accelerator: "Cmd+Shift+O",
          click: () => openFileDialog(),
        },
        { type: "separator" },
        {
          label: "Reveal in Finder",
          accelerator: "Cmd+R",
          click: () => {
            if (lastOpenedFile) shell.showItemInFolder(lastOpenedFile);
          },
        },
        { type: "separator" },
        { label: "Close Window", accelerator: "Cmd+W", role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find in Document",
          accelerator: "Cmd+F",
          click: () => mainWindow?.webContents.send("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "Cmd+\\",
          click: () => mainWindow?.webContents.send("toggle-sidebar"),
        },
        {
          label: "Toggle TOC",
          accelerator: "Cmd+Shift+T",
          click: () => mainWindow?.webContents.send("toggle-toc"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ----- File dialogs -----

async function openFolderDialog(defaultPath) {
  if (!mainWindow) return { canceled: true };
  const opts = {
    properties: ["openDirectory"],
    title: "Open a folder",
  };
  if (defaultPath && typeof defaultPath === "string") {
    opts.defaultPath = defaultPath;
  }
  const result = await dialog.showOpenDialog(mainWindow, opts);
  if (!result.canceled && result.filePaths.length) {
    setOpenedFolder(result.filePaths[0]);
    return { canceled: false, path: result.filePaths[0] };
  }
  return { canceled: true };
}

async function openFileDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Supported", extensions: ["md", "markdown", "mdown", "mkd", "csv", "tsv", "html", "htm"] },
      { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
      { name: "HTML", extensions: ["html", "htm"] },
      { name: "CSV / TSV", extensions: ["csv", "tsv"] },
    ],
    title: "Open a file",
  });
  if (!result.canceled && result.filePaths.length) {
    const filePath = result.filePaths[0];
    setOpenedFolder(path.dirname(filePath));
    mainWindow.webContents.send("file-opened", filePath);
  }
}

function setOpenedFolder(folderPath) {
  lastOpenedFolder = folderPath;
  mainWindow?.webContents.send("folder-opened", folderPath);
}

// ----- IPC handlers -----

ipcMain.handle("list-dir", async (_event, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
        isMarkdown: !e.isDirectory() && /\.(md|markdown|mdown|mkd)$/i.test(e.name),
        isCsv: !e.isDirectory() && /\.(csv|tsv)$/i.test(e.name),
        isHtml: !e.isDirectory() && /\.(html|htm)$/i.test(e.name),
        isReadme: !e.isDirectory() && /^readme\.(md|markdown)$/i.test(e.name),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        if (a.isReadme !== b.isReadme) return a.isReadme ? -1 : 1;
        return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      });
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("render-md", async (_event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = render(raw, { fallbackTitle: path.basename(filePath, path.extname(filePath)) });
    const stat = fs.statSync(filePath);
    lastOpenedFile = filePath;
    return {
      ok: true,
      doc: {
        path: filePath,
        title: doc.title,
        html: doc.html,
        toc: doc.toc,
        taskListCount: doc.taskListCount,
        language: doc.language,
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
        raw,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("render-csv", async (_event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    // .tsv → force tab separator; otherwise auto-detect.
    const forceTab = /\.tsv$/i.test(filePath);
    const { rows, separator } = parseCsv(raw, forceTab ? "\t" : null);
    const stat = fs.statSync(filePath);
    lastOpenedFile = filePath;
    return {
      ok: true,
      doc: {
        path: filePath,
        kind: "csv",
        title: path.basename(filePath),
        rows,
        separator,
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("render-html", async (_event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const stat = fs.statSync(filePath);
    lastOpenedFile = filePath;
    // Prefer the document's own <title>; fall back to the filename.
    let title = path.basename(filePath, path.extname(filePath));
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1].trim()) title = m[1].trim().replace(/\s+/g, " ");
    return {
      ok: true,
      doc: {
        path: filePath,
        kind: "html",
        title,
        raw,
        modifiedAt: stat.mtime.toISOString(),
        size: stat.size,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("render-string", async (_event, raw, fallbackTitle) => {
  try {
    const doc = render(raw || "", { fallbackTitle: fallbackTitle || "Untitled" });
    return {
      ok: true,
      doc: {
        title: doc.title,
        html: doc.html,
        toc: doc.toc,
        taskListCount: doc.taskListCount,
        language: doc.language,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("rename-file", async (_event, oldPath, newName) => {
  if (!oldPath || typeof newName !== "string") {
    return { ok: false, error: "Invalid arguments" };
  }
  const cleaned = newName.trim();
  if (!cleaned) return { ok: false, error: "Name cannot be empty" };
  // Forbid path separators in the new name — keep it a simple rename.
  if (/[\\/]/.test(cleaned)) {
    return { ok: false, error: "Name cannot contain slashes" };
  }
  // Preserve the source extension if the user typed only a base name.
  const sourceExtMatch = oldPath.match(/\.(md|markdown|mdown|mkd|csv|tsv)$/i);
  const sourceExt = sourceExtMatch ? sourceExtMatch[0] : ".md";
  const hasExt = /\.[A-Za-z0-9]+$/.test(cleaned);
  const finalName = hasExt ? cleaned : cleaned + sourceExt;
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, finalName);
    if (newPath === oldPath) return { ok: true, path: newPath, name: finalName, changed: false };
    if (fs.existsSync(newPath)) {
      return { ok: false, error: "A file with that name already exists" };
    }
    if (watcher) { watcher.close(); watcher = null; }
    fs.renameSync(oldPath, newPath);
    return { ok: true, path: newPath, name: finalName, changed: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("save-md-as", async (_event, payload) => {
  if (!mainWindow) return { ok: false };
  const content = (payload && typeof payload.content === "string") ? payload.content : "";
  const defaultPath = payload && payload.defaultPath ? payload.defaultPath : undefined;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save as…",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    let target = result.filePath;
    // Force the markdown extension so the saved file stays recognisable.
    if (!/\.(md|markdown)$/i.test(target)) target += ".md";
    if (watcher) { watcher.close(); watcher = null; }
    fs.writeFileSync(target, content, "utf8");
    const stat = fs.statSync(target);
    return { ok: true, path: target, modifiedAt: stat.mtime.toISOString(), size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("write-md", async (_event, filePath, content) => {
  if (!filePath || typeof content !== "string") {
    return { ok: false, error: "Invalid arguments" };
  }
  try {
    // Pause our own watcher around the write so we don't bounce ourselves
    // into a re-render of stale content the user just edited away from.
    if (watcher) { watcher.close(); watcher = null; }
    fs.writeFileSync(filePath, content, "utf8");
    const stat = fs.statSync(filePath);
    return { ok: true, modifiedAt: stat.mtime.toISOString(), size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("write-file", async (_event, filePath, content) => {
  if (!filePath || typeof content !== "string") {
    return { ok: false, error: "Invalid arguments" };
  }
  try {
    // Pause our own watcher around the write so saving back to disk doesn't
    // bounce us into a reload of content we just serialized.
    if (watcher) { watcher.close(); watcher = null; }
    fs.writeFileSync(filePath, content, "utf8");
    const stat = fs.statSync(filePath);
    return { ok: true, modifiedAt: stat.mtime.toISOString(), size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("show-in-finder", async (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

ipcMain.handle("copy-to-clipboard", async (_event, text) => {
  if (typeof text === "string") clipboard.writeText(text);
  return { ok: true };
});

/**
 * Open a new Terminal window at the given folder and run the `claude`
 * CLI (Claude Code). Uses osascript so the Terminal app's "do script"
 * pipeline creates/refreshes a window/tab cleanly.
 */
ipcMain.handle("open-folder-in-claude-code", async (_event, folderPath) => {
  if (!folderPath || typeof folderPath !== "string") {
    return { ok: false, error: "No folder provided" };
  }
  try {
    // POSIX single-quote escaping: each ' inside the path becomes '\''
    const shellSafePath = folderPath.replace(/'/g, "'\\''");
    const shellCmd = `cd '${shellSafePath}' && claude`;
    // AppleScript string escaping: backslashes then double quotes.
    const asEscaped = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script =
      `tell application "Terminal"\n` +
      `  activate\n` +
      `  do script "${asEscaped}"\n` +
      `end tell`;
    const proc = spawn("osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("open-external", async (_event, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

ipcMain.handle("export-html", async (_event, { html, suggestedName }) => {
  if (!mainWindow) return { ok: false };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export as HTML",
    defaultPath: (suggestedName || "document") + ".html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, html, "utf8");
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on("watch-file", (_event, filePath) => {
  if (watcher) { watcher.close(); watcher = null; }
  if (!filePath || !fs.existsSync(filePath)) return;
  watcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });
  watcher.on("change", () => {
    mainWindow?.webContents.send("file-changed", filePath);
  });
});

ipcMain.on("unwatch-file", () => {
  if (watcher) { watcher.close(); watcher = null; }
});

ipcMain.handle("request-folder", (_e, defaultPath) => openFolderDialog(defaultPath));
ipcMain.handle("request-file", () => openFileDialog());

ipcMain.handle("get-state", () => ({
  lastOpenedFolder,
  lastOpenedFile,
  platform: process.platform,
}));

// ----- Lifecycle -----

app.whenReady().then(() => {
  // Pick up any .md path passed via argv (some launch contexts deliver the
  // file this way instead of through open-file).
  if (!lastOpenedFile) {
    const argvFile = pickArgvFile();
    if (argvFile) {
      lastOpenedFile = argvFile;
      lastOpenedFolder = path.dirname(argvFile);
    }
  }
  createWindow();
  // Push any cached file to the renderer once it finishes loading.
  mainWindow.webContents.once("did-finish-load", () => {
    deliverPendingFileToRenderer();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (watcher) { watcher.close(); watcher = null; }
  if (process.platform !== "darwin") app.quit();
});

// Open file from Finder ("Open With…", double-click, drag-on-dock). Fires
// before or after `ready` depending on launch path; we cache the path
// unconditionally and deliver to the renderer when it's available.
//
// macOS keeps the app alive after the window is closed. If a file is opened
// in that windowless state, we re-create the window and let `did-finish-load`
// pick the cached file up — matching the behaviour users expect from native
// document apps (TextEdit, Preview, etc.).
app.on("open-file", (e, filePath) => {
  e.preventDefault();
  lastOpenedFile = filePath;
  lastOpenedFolder = path.dirname(filePath);
  if (!app.isReady()) return; // pre-`ready`: whenReady handler will deliver
  if (!windowAlive()) {
    createWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      deliverPendingFileToRenderer();
    });
    return;
  }
  deliverPendingFileToRenderer();
  // Bring the existing window to the foreground so the user sees the new doc.
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
