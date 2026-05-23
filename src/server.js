import express from "express";
import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

import { render } from "./render.js";
import { renderPage, readCss, readJs } from "./template.js";
import { buildTree, defaultInitialFile } from "./tree.js";

function isFreePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

export async function pickPort(preferred, low = 8400, high = 8499) {
  if (preferred) {
    if (await isFreePort(preferred)) return preferred;
    throw new Error(`Port ${preferred} is in use`);
  }
  for (let p = low; p <= high; p++) {
    if (await isFreePort(p)) return p;
  }
  // Last-ditch wide search
  for (let p = 8000; p <= 9000; p++) {
    if (await isFreePort(p)) return p;
  }
  throw new Error("No free port found in 8000–9000");
}

export async function startFolderServer(folderDir, opts = {}) {
  const { port, includeHidden = false } = opts;
  const root = path.resolve(folderDir);

  const app = express();
  app.disable("x-powered-by");

  const watcherClients = new Set();

  // Watch markdown files for changes.
  const watcher = chokidar.watch(root, {
    ignored: (p) => {
      const base = path.basename(p);
      if (base.startsWith(".") && !includeHidden) return true;
      if (["node_modules", ".git", "dist", "build"].includes(base)) return true;
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });

  function broadcast(payload) {
    const data = `event: change\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of watcherClients) {
      try { res.write(data); } catch { /* ignore */ }
    }
  }

  watcher.on("change", (filePath) => {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    if (rel.toLowerCase().endsWith(".md")) broadcast({ path: rel });
  });
  watcher.on("add", () => broadcast({ tree: true }));
  watcher.on("unlink", () => broadcast({ tree: true }));
  watcher.on("addDir", () => broadcast({ tree: true }));
  watcher.on("unlinkDir", () => broadcast({ tree: true }));

  // Asset routes
  app.get("/__kindmd__/styles.css", (req, res) => {
    res.type("text/css").send(readCss());
  });
  app.get("/__kindmd__/runtime.js", (req, res) => {
    res.type("application/javascript").send(readJs());
  });

  // Tree
  app.get("/api/tree", (req, res) => {
    try {
      const tree = buildTree(root, { includeHidden });
      res.json(tree);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Doc API
  app.get("/api/doc", (req, res) => {
    const relPath = String(req.query.path || "").replace(/^\/+/, "");
    if (!relPath) return res.status(400).json({ error: "Missing path" });
    const safe = safePath(root, relPath);
    if (!safe) return res.status(403).json({ error: "Path outside root" });
    if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
      return res.status(404).json({ error: "File not found" });
    }
    try {
      const raw = fs.readFileSync(safe, "utf8");
      const doc = render(raw, { fallbackTitle: path.basename(safe, ".md") });
      const stat = fs.statSync(safe);
      res.json({
        path: relPath,
        title: doc.title,
        html: doc.html,
        toc: doc.toc,
        taskListCount: doc.taskListCount,
        language: doc.language,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // SSE
  app.get("/api/watch", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.flushHeaders();
    res.write(`event: hello\ndata: {}\n\n`);
    watcherClients.add(res);
    const keepalive = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch { /* ignore */ }
    }, 25000);
    req.on("close", () => {
      clearInterval(keepalive);
      watcherClients.delete(res);
    });
  });

  // Static pass-through for images and other non-markdown assets
  // (path resolved relative to root, must stay inside root).
  app.get(/.*/, (req, res, next) => {
    const reqPath = decodeURIComponent(req.path.replace(/^\/+/, ""));

    // Render full page for /, or any path that resolves to an md file, or any path.
    let target;
    if (reqPath === "") {
      target = "";
    } else {
      target = reqPath;
    }

    const tree = buildTree(root, { includeHidden });
    const initialPath = target && /\.md$/i.test(target) ? target : defaultInitialFile(tree);

    if (!initialPath) {
      // Empty folder — render shell with an empty state
      const emptyDoc = {
        title: "kindmd",
        html: `<div class="kindmd-empty"><p><em>No markdown files in this folder.</em></p></div>`,
        toc: [],
        taskListCount: 0,
        language: "en",
      };
      return res
        .type("text/html")
        .send(renderPage({ doc: emptyDoc, docPath: "", modifiedAt: "", mode: "folder", inline: false }));
    }

    const safe = safePath(root, initialPath);
    if (!safe) return next();

    // If the requested target is a non-markdown file inside root, serve it raw.
    if (target && !/\.md$/i.test(target)) {
      const safeAsset = safePath(root, target);
      if (safeAsset && fs.existsSync(safeAsset) && fs.statSync(safeAsset).isFile()) {
        return res.sendFile(safeAsset);
      }
    }

    if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
      const emptyDoc = {
        title: "kindmd",
        html: `<div class="kindmd-empty"><p class="kindmd-error">File not found: <code>${initialPath}</code></p></div>`,
        toc: [],
        taskListCount: 0,
        language: "en",
      };
      return res
        .type("text/html")
        .send(renderPage({ doc: emptyDoc, docPath: "", modifiedAt: "", mode: "folder", inline: false }));
    }

    try {
      const raw = fs.readFileSync(safe, "utf8");
      const doc = render(raw, { fallbackTitle: path.basename(safe, ".md") });
      const stat = fs.statSync(safe);
      const html = renderPage({
        doc,
        docPath: initialPath,
        modifiedAt: stat.mtime.toISOString(),
        mode: "folder",
        inline: false,
      });
      res.type("text/html").send(html);
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });

  const chosenPort = await pickPort(port);
  const server = app.listen(chosenPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const close = () =>
    new Promise((resolve) => {
      watcher.close();
      for (const r of watcherClients) { try { r.end(); } catch { /* ignore */ } }
      server.close(() => resolve());
    });

  return { port: chosenPort, server, close };
}

function safePath(root, relPath) {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}
