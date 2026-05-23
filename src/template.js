import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLIENT_DIR = path.join(ROOT, "client");

let cachedCss = null;
let cachedJs = null;

export function readCss() {
  if (!cachedCss) cachedCss = fs.readFileSync(path.join(CLIENT_DIR, "styles.css"), "utf8");
  return cachedCss;
}

export function readJs() {
  if (!cachedJs) cachedJs = fs.readFileSync(path.join(CLIENT_DIR, "runtime.js"), "utf8");
  return cachedJs;
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/**
 * Render the full HTML page shell.
 * @param {object} opts
 * @param {object} opts.doc        RenderedDoc for the initial document.
 * @param {string} [opts.docPath]  Relative path for the doc (folder mode).
 * @param {string} [opts.modifiedAt] ISO timestamp for the footer.
 * @param {"file" | "folder" | "export"} opts.mode
 * @param {boolean} [opts.inline]  Inline CSS + JS into the document.
 * @param {string} [opts.cssUrl]   URL when not inlining CSS.
 * @param {string} [opts.jsUrl]    URL when not inlining JS.
 */
export function renderPage(opts) {
  const {
    doc,
    docPath = "",
    modifiedAt = "",
    mode,
    inline = false,
    cssUrl = "/__kindmd__/styles.css",
    jsUrl = "/__kindmd__/runtime.js",
  } = opts;

  const cssBlock = inline
    ? `<style>\n${readCss()}\n</style>`
    : `<link rel="stylesheet" href="${escAttr(cssUrl)}">`;

  const jsBlock = inline
    ? `<script>\n${readJs()}\n</script>`
    : `<script src="${escAttr(jsUrl)}" defer></script>`;

  const tocHtml = doc.toc.length
    ? `<ol class="kindmd-toc-list">\n` +
      doc.toc.map(({ id, text, num }) => (
        `  <li><a href="#${escAttr(id)}" data-toc-target="${escAttr(id)}">` +
        `<span class="kindmd-toc-num">${escText(num)}</span>` +
        `<span class="kindmd-toc-text">${escText(text)}</span>` +
        `</a></li>`
      )).join("\n") +
      `\n</ol>`
    : `<p class="kindmd-toc-empty"><em>No sections.</em></p>`;

  const progressRing = ""; // task list progress is no longer rendered

  const fileTreeBlock = mode === "folder"
    ? `<nav class="kindmd-tree" aria-label="Files">
      <h2 class="kindmd-tree-title">Files</h2>
      <div class="kindmd-tree-body" data-tree>
        <p class="kindmd-tree-loading"><em>Loading…</em></p>
      </div>
    </nav>`
    : "";

  const bodyClass = mode === "folder" ? "kindmd-mode-folder" : "kindmd-mode-file";

  const footer = mode === "folder"
    ? `<footer class="kindmd-footer">
      <span class="kindmd-footer-path" data-footer-path>${escText(docPath || "")}</span>
      <span class="kindmd-footer-sep" aria-hidden="true">·</span>
      <span class="kindmd-footer-modified" data-footer-modified>${escText(modifiedAt || "")}</span>
    </footer>`
    : `<footer class="kindmd-footer">
      <span class="kindmd-footer-path">${escText(docPath || "")}</span>
      <span class="kindmd-footer-sep" aria-hidden="true">·</span>
      <span class="kindmd-footer-modified">${escText(modifiedAt || "")}</span>
    </footer>`;

  const bootData = {
    mode,
    docPath,
    initialDoc: {
      title: doc.title,
      toc: doc.toc,
      taskListCount: doc.taskListCount,
      language: doc.language,
      path: docPath,
      modifiedAt,
    },
  };

  return `<!doctype html>
<html lang="${escAttr(doc.language || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escText(doc.title)}</title>
<meta name="generator" content="kindmd">
${cssBlock}
</head>
<body class="${bodyClass}">
<a class="kindmd-skip-link" href="#main">Skip to content</a>
<header class="kindmd-masthead" role="banner">
  <div class="kindmd-masthead-inner">
    <a class="kindmd-brand" href="/" aria-label="kindmd home">
      <span class="kindmd-brand-mark" aria-hidden="true">kind<span class="kindmd-brand-dot">·</span>md</span>
    </a>
    <h1 class="kindmd-title" data-title>${escText(doc.title)}</h1>
    <div class="kindmd-masthead-tools">
      <form class="kindmd-search" role="search" data-search>
        <label class="kindmd-visually-hidden" for="kindmd-search-input">Search this document</label>
        <input id="kindmd-search-input" type="search" placeholder="Search (⌘K)" autocomplete="off" spellcheck="false" data-search-input>
        <span class="kindmd-search-count" aria-live="polite" data-search-count></span>
      </form>
      ${progressRing}
      <button class="kindmd-export" type="button" data-export aria-label="Export as self-contained HTML">Export</button>
    </div>
  </div>
</header>
<div class="kindmd-layout">
  ${fileTreeBlock}
  <main id="main" class="kindmd-main" tabindex="-1">
    <article class="kindmd-article" data-article>
      ${doc.html}
    </article>
    ${footer}
  </main>
  <aside class="kindmd-toc" aria-label="Contents">
    <h2 class="kindmd-toc-title">Contents</h2>
    <div data-toc>${tocHtml}</div>
  </aside>
</div>
<script id="kindmd-boot" type="application/json">${JSON.stringify(bootData).replace(/</g, "\\u003c")}</script>
${jsBlock}
</body>
</html>`;
}
