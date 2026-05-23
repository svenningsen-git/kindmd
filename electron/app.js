/* Renderer-process script. Runs in the Electron BrowserWindow.
   The native bridge is exposed as window.kindmd via preload.cjs. */
(function () {
  "use strict";

  const { kindmd } = window;
  if (!kindmd) {
    document.body.innerHTML = "<p style='padding:32px'>kindmd bridge missing.</p>";
    return;
  }

  // ---------- Refs ----------
  const $ = (sel) => document.querySelector(sel);
  const appEl = $(".kindmd-app");
  const treeEl = $("[data-tree]");
  const folderNameEl = $("[data-folder-name]");
  const articleEl = $("[data-article]");
  const titleEl = $("[data-title]");
  const tocEl = $("[data-toc]");
  const tocPaneEl = $("[data-toc-pane]");
  const sidebarEl = $("[data-sidebar]");
  const searchInput = $("[data-search-input]");
  const searchCount = $("[data-search-count]");
  const exportBtn = $("[data-export]");
  const editToggleBtn = $("[data-edit-toggle]");
  const editLabel = $("[data-edit-label]");
  const editDirtyDot = $("[data-edit-dirty]");
  const editPane = $("[data-edit-pane]");
  const editTextarea = $("[data-edit-textarea]");
  const editHints = $("[data-edit-hints]");
  const footerEl = $("[data-footer]");
  const footerPath = $("[data-footer-path]");
  const footerModified = $("[data-footer-modified]");

  // ---------- State ----------
  const state = {
    rootFolder: null,
    currentFile: null,
    currentFileKind: null, // 'md' | 'csv'
    currentDoc: null,
    currentRaw: "",
    editMode: false,
    dirty: false,
    searchMatches: [],
    searchIndex: -1,
    treeCollapsedMap: lsGet("kindmd:app:tree-collapsed", {}),
    sectionCollapseByFile: lsGet("kindmd:app:section-collapsed", {}),
    csv: null, // { rows, headers, hiddenCols:Set, filters:Map, sortBy, textFilter }
  };

  function fileKindOf(path) {
    if (!path) return null;
    if (/\.(csv|tsv)$/i.test(path)) return "csv";
    if (/\.(md|markdown|mdown|mkd)$/i.test(path)) return "md";
    return null;
  }

  // ---------- localStorage helpers ----------
  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- Color swatches ----------

  // #rgb, #rgba, #rrggbb, #rrggbbaa, plus modern functional color forms.
  const COLOR_RE_SOURCE =
    "(?:" +
    "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])" +
    "|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\\([^)]+\\)" +
    ")";
  const COLOR_RE_TEST = new RegExp(COLOR_RE_SOURCE);
  const _colorProbe = document.createElement("div");

  function isValidColor(value) {
    if (typeof CSS !== "undefined" && CSS.supports) {
      return CSS.supports("background-color", value);
    }
    _colorProbe.style.backgroundColor = "";
    _colorProbe.style.backgroundColor = value;
    return _colorProbe.style.backgroundColor !== "";
  }

  function injectColorSwatches(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        let p = node.parentNode;
        while (p && p !== root) {
          if (!p.tagName) { p = p.parentNode; continue; }
          const tag = p.tagName;
          if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
          if (p.classList && (p.classList.contains("kindmd-color") || p.classList.contains("kindmd-color-swatch"))) {
            return NodeFilter.FILTER_REJECT;
          }
          // Skip headings — color codes in headings are uncommon and look noisy with a swatch.
          if (/^H[1-6]$/.test(tag)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return COLOR_RE_TEST.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const node of nodes) {
      const text = node.nodeValue;
      const re = new RegExp(COLOR_RE_SOURCE, "g");
      const frag = document.createDocumentFragment();
      let from = 0;
      let inserted = false;
      let m;
      while ((m = re.exec(text)) !== null) {
        const matched = m[0];
        if (!isValidColor(matched)) continue;
        if (m.index > from) {
          frag.appendChild(document.createTextNode(text.slice(from, m.index)));
        }
        const wrap = document.createElement("span");
        wrap.className = "kindmd-color";
        const swatch = document.createElement("span");
        swatch.className = "kindmd-color-swatch";
        swatch.style.backgroundColor = matched;
        swatch.setAttribute("aria-hidden", "true");
        wrap.appendChild(swatch);
        wrap.appendChild(document.createTextNode(matched));
        frag.appendChild(wrap);
        from = m.index + matched.length;
        inserted = true;
      }
      if (inserted) {
        if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // ---------- File tree (Finder-like) ----------

  function basename(p) {
    if (!p) return "";
    const parts = p.split("/");
    return parts[parts.length - 1] || p;
  }

  async function setRootFolder(folderPath) {
    state.rootFolder = folderPath;
    folderNameEl.textContent = basename(folderPath);
    treeEl.innerHTML = `<p class="kindmd-app-tree-empty"><em>Loading…</em></p>`;
    await loadAndRenderRoot();
  }

  async function loadAndRenderRoot() {
    if (!state.rootFolder) return;
    const items = await kindmd.listDir(state.rootFolder);
    if (items && items.error) {
      treeEl.innerHTML = `<p class="kindmd-app-tree-empty"><em>${escapeHtml(items.error)}</em></p>`;
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "kindmd-app-tree-root";
    for (const item of items) ul.appendChild(buildTreeNode(item, 0));
    treeEl.innerHTML = "";
    treeEl.appendChild(ul);

    // Auto-open the first .md (README first if present)
    const firstMd = findFirstMd(items);
    if (firstMd && !state.currentFile) loadDocument(firstMd.path);
  }

  function findFirstMd(items) {
    for (const it of items) {
      if (!it.isDirectory && it.isMarkdown) return it;
    }
    // Fallback: depth-first inside folders is too eager — Finder users expect
    // the root-level open. Keep it shallow.
    return null;
  }

  function buildTreeNode(item, depth) {
    const li = document.createElement("li");
    li.className = "kindmd-app-tree-node";
    if (item.isDirectory) {
      li.classList.add("kindmd-app-tree-folder");
      const isCollapsed = !!state.treeCollapsedMap[item.path];
      if (isCollapsed) li.classList.add("is-collapsed");

      const row = document.createElement("div");
      row.className = "kindmd-app-tree-row";
      row.innerHTML =
        `<span class="kindmd-app-tree-chevron" aria-hidden="true">▾</span>` +
        `<span class="kindmd-app-tree-icon" aria-hidden="true">📁</span>` +
        `<span class="kindmd-app-tree-label">${escapeHtml(item.name)}</span>`;
      row.addEventListener("click", () => toggleFolder(li, item, ul));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, { type: "folder", path: item.path });
      });

      const ul = document.createElement("ul");
      ul.className = "kindmd-app-tree-children";
      ul.dataset.loaded = "false";

      li.appendChild(row);
      li.appendChild(ul);
    } else {
      const row = document.createElement("div");
      row.className = "kindmd-app-tree-row";
      row.dataset.filePath = item.path;
      if (item.isMarkdown || item.isCsv) {
        const icon = item.isCsv ? "▦" : "¶";
        row.classList.add(item.isCsv ? "is-csv" : "is-md");
        row.innerHTML =
          `<span class="kindmd-app-tree-chevron-spacer" aria-hidden="true"></span>` +
          `<span class="kindmd-app-tree-icon" aria-hidden="true">${icon}</span>` +
          `<span class="kindmd-app-tree-label">${escapeHtml(item.name)}</span>`;
        // Single click loads. dblclick puts the row into rename mode — we
        // delay the load briefly so it doesn't fire when a double click is
        // in progress.
        let clickTimer = null;
        row.addEventListener("click", () => {
          if (clickTimer) clearTimeout(clickTimer);
          clickTimer = setTimeout(() => {
            clickTimer = null;
            if (!row.classList.contains("is-renaming")) loadDocument(item.path);
          }, 220);
        });
        row.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          startRenameInTree(row, item);
        });
      } else {
        row.classList.add("is-disabled");
        row.innerHTML =
          `<span class="kindmd-app-tree-chevron-spacer" aria-hidden="true"></span>` +
          `<span class="kindmd-app-tree-icon" aria-hidden="true">·</span>` +
          `<span class="kindmd-app-tree-label">${escapeHtml(item.name)}</span>`;
      }
      li.appendChild(row);
    }
    return li;
  }

  async function toggleFolder(folderLi, item, _children) {
    const ul = folderLi.querySelector(":scope > ul.kindmd-app-tree-children");
    if (!ul) return;
    const willCollapse = !folderLi.classList.contains("is-collapsed");
    // Lazy-load on first expand
    if (!willCollapse && ul.dataset.loaded === "false") {
      ul.innerHTML = `<li class="kindmd-app-tree-node"><div class="kindmd-app-tree-row is-disabled"><span class="kindmd-app-tree-chevron-spacer"></span><span class="kindmd-app-tree-icon">·</span><span class="kindmd-app-tree-label"><em>Loading…</em></span></div></li>`;
      const children = await kindmd.listDir(item.path);
      ul.innerHTML = "";
      if (children && children.error) {
        ul.innerHTML = `<li class="kindmd-app-tree-node"><div class="kindmd-app-tree-row is-disabled"><span class="kindmd-app-tree-chevron-spacer"></span><span class="kindmd-app-tree-icon">·</span><span class="kindmd-app-tree-label"><em>${escapeHtml(children.error)}</em></span></div></li>`;
      } else {
        for (const child of children) ul.appendChild(buildTreeNode(child, 0));
      }
      ul.dataset.loaded = "true";
    }
    folderLi.classList.toggle("is-collapsed", willCollapse);
    if (willCollapse) state.treeCollapsedMap[item.path] = true;
    else delete state.treeCollapsedMap[item.path];
    lsSet("kindmd:app:tree-collapsed", state.treeCollapsedMap);
  }

  // ---------- Right-click context menu ----------

  const ctxMenuEl = document.querySelector("[data-context-menu]");
  let ctxMenuTarget = null;

  function showContextMenu(x, y, target) {
    if (!ctxMenuEl) return;
    ctxMenuTarget = target;
    ctxMenuEl.hidden = false;
    // Tentative position
    ctxMenuEl.style.left = x + "px";
    ctxMenuEl.style.top = y + "px";
    // Adjust if it would overflow viewport
    const rect = ctxMenuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw - 8) ctxMenuEl.style.left = Math.max(8, vw - rect.width - 8) + "px";
    if (rect.bottom > vh - 8) ctxMenuEl.style.top = Math.max(8, vh - rect.height - 8) + "px";
  }

  function hideContextMenu() {
    if (!ctxMenuEl) return;
    ctxMenuEl.hidden = true;
    ctxMenuTarget = null;
  }

  if (ctxMenuEl) {
    ctxMenuEl.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn || !ctxMenuTarget) return;
      const action = btn.getAttribute("data-action");
      const { path: targetPath } = ctxMenuTarget;
      hideContextMenu();
      if (action === "open-in-claude-code") {
        const res = await kindmd.openFolderInClaudeCode(targetPath);
        if (!res || !res.ok) flashMessage(`Couldn't open Claude Code: ${res?.error || "unknown"}`);
      } else if (action === "reveal-in-finder") {
        kindmd.showInFinder(targetPath);
      } else if (action === "copy-path") {
        kindmd.copyToClipboard(targetPath);
        flashMessage("Path copied");
      }
    });
  }

  // Dismiss on outside click / scroll / Escape
  document.addEventListener("mousedown", (e) => {
    if (ctxMenuEl && !ctxMenuEl.hidden && !ctxMenuEl.contains(e.target)) {
      hideContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ctxMenuEl && !ctxMenuEl.hidden) {
      hideContextMenu();
    }
  });
  window.addEventListener("blur", hideContextMenu);

  // ---------- Inline rename in the file tree ----------

  function startRenameInTree(rowEl, item) {
    if (rowEl.classList.contains("is-renaming")) return;
    const labelEl = rowEl.querySelector(".kindmd-app-tree-label");
    if (!labelEl) return;
    rowEl.classList.add("is-renaming");
    const originalName = item.name;
    const input = document.createElement("input");
    input.type = "text";
    input.value = originalName;
    input.className = "kindmd-app-tree-rename";
    input.spellcheck = false;
    input.autocomplete = "off";
    labelEl.style.display = "none";
    labelEl.parentNode.insertBefore(input, labelEl);
    input.focus();
    // Pre-select the base name (without the .md extension).
    const dot = originalName.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot); else input.select();

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      input.remove();
      labelEl.style.display = "";
      rowEl.classList.remove("is-renaming");
    };
    const commit = async (newName) => {
      if (!newName || newName === originalName) {
        cleanup();
        return;
      }
      const wasCurrent = state.currentFile === item.path;
      const result = await kindmd.renameFile(item.path, newName);
      if (!result || !result.ok) {
        flashMessage(`Rename failed: ${result?.error || "unknown"}`);
        input.focus();
        input.select();
        finished = false;
        return;
      }
      cleanup();
      // Refresh tree so the rename + sort order reflect the change.
      await loadAndRenderRoot();
      // If we renamed the open file, follow it.
      if (wasCurrent && result.path) {
        await loadDocument(result.path);
      }
      flashMessage(`Renamed → ${result.name}`);
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // prevent global Cmd-F etc.
      if (e.key === "Enter") {
        e.preventDefault();
        commit(input.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
      }
    });
    input.addEventListener("blur", () => {
      // If user clicks away, treat as commit. If unchanged, just cleanup.
      const v = input.value.trim();
      if (!v || v === originalName) cleanup();
      else commit(v);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
  }

  function highlightActiveInTree() {
    const rows = treeEl.querySelectorAll(".kindmd-app-tree-row[data-file-path]");
    rows.forEach((r) => {
      r.classList.toggle("is-active", r.dataset.filePath === state.currentFile);
    });
  }

  // ---------- Document loading ----------

  async function loadDocument(filePath, opts = {}) {
    const { preserveScroll = false } = opts;
    const kind = fileKindOf(filePath) || "md";
    // If switching docs while in edit mode with unsaved changes, auto-save first.
    if (state.editMode && state.dirty && state.currentFile && state.currentFile !== filePath) {
      await saveEdits({ silent: true });
    }
    // Always leave edit mode when switching docs (dirty already saved above).
    if (state.editMode && state.currentFile !== filePath) {
      await exitEditMode();
    }
    if (kind === "csv") {
      return loadCsvDocument(filePath, opts);
    }
    const scrollY = preserveScroll ? document.querySelector(".kindmd-app-main").scrollTop : 0;
    const res = await kindmd.renderMd(filePath);
    if (!res || !res.ok) {
      articleEl.innerHTML = `<div class="kindmd-empty"><p class="kindmd-error">Failed to load <code>${escapeHtml(filePath)}</code>.${res?.error ? ` ${escapeHtml(res.error)}` : ""}</p></div>`;
      return;
    }
    const doc = res.doc;
    state.currentFile = filePath;
    state.currentFileKind = "md";
    state.currentDoc = doc;
    state.currentRaw = doc.raw || "";
    state.csv = null;
    state.dirty = false;
    setDirtyIndicator(false);
    if (editToggleBtn) editToggleBtn.disabled = false;
    document.body.classList.remove("kindmd-csv-active");

    titleEl.textContent = doc.title;
    document.title = `${doc.title} — kindmd`;
    if (footerEl) footerEl.style.display = "";
    footerPath.textContent = doc.path;
    footerModified.textContent = formatModified(doc.modifiedAt);

    articleEl.hidden = false;
    articleEl.innerHTML = doc.html;
    injectColorSwatches(articleEl);
    attachCopyButtonsToTables(articleEl);
    rebuildToc(doc.toc);
    wireSectionToggles();
    restoreSectionCollapse();
    wireInternalLinks();
    rebuildTocObserver();
    highlightActiveInTree();

    kindmd.watchFile(filePath);

    const mainEl = document.querySelector(".kindmd-app-main");
    if (preserveScroll) mainEl.scrollTop = scrollY;
    else mainEl.scrollTop = 0;
  }

  // ---------- CSV mode ----------

  async function loadCsvDocument(filePath, opts = {}) {
    const { preserveScroll = false } = opts;
    const scrollY = preserveScroll ? document.querySelector(".kindmd-app-main").scrollTop : 0;
    const res = await kindmd.renderCsv(filePath);
    if (!res || !res.ok) {
      articleEl.innerHTML = `<div class="kindmd-empty"><p class="kindmd-error">Failed to load <code>${escapeHtml(filePath)}</code>.${res?.error ? ` ${escapeHtml(res.error)}` : ""}</p></div>`;
      return;
    }
    const doc = res.doc;
    const rows = doc.rows || [];
    // First row is the header. Pad/clean up.
    const headers = (rows[0] || []).map((h, i) => h || `Column ${colLetter(i)}`);
    const dataRows = rows.slice(1);

    state.currentFile = filePath;
    state.currentFileKind = "csv";
    state.currentDoc = doc;
    state.currentRaw = "";
    state.dirty = false;
    setDirtyIndicator(false);
    state.csv = {
      headers,
      rows: dataRows,
      separator: doc.separator || ",",
      hiddenCols: new Set(),
      filters: new Map(), // colIdx -> Set<value>
      sortBy: null, // { col, dir }
      textFilter: "",
      openFilterPopover: null,
    };

    document.body.classList.add("kindmd-csv-active");
    if (editToggleBtn) editToggleBtn.disabled = true; // no edit mode for CSV (v1)

    titleEl.textContent = doc.title;
    document.title = `${doc.title} — kindmd`;
    // Footer + TOC pane are CSV-irrelevant. The table fills to the window edge.
    if (footerEl) footerEl.style.display = "none";

    articleEl.hidden = false;
    // Clear leftover read-mode search marks/state so they don't leak in.
    state.searchMatches = [];
    state.searchIndex = -1;
    if (searchInput) searchInput.value = "";
    if (searchCount) { searchCount.textContent = ""; searchCount.classList.remove("is-empty"); }
    renderCsvIntoArticle();
    highlightActiveInTree();

    kindmd.watchFile(filePath);

    const mainEl = document.querySelector(".kindmd-app-main");
    if (preserveScroll) mainEl.scrollTop = scrollY;
    else mainEl.scrollTop = 0;
  }

  // Spreadsheet column letters: 0 → "A", 25 → "Z", 26 → "AA", …
  function colLetter(idx) {
    let n = idx + 1;
    let out = "";
    while (n > 0) {
      const r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function visibleColIndices() {
    if (!state.csv) return [];
    const out = [];
    for (let i = 0; i < state.csv.headers.length; i++) {
      if (!state.csv.hiddenCols.has(i)) out.push(i);
    }
    return out;
  }

  // Filter + sort the raw row set against the current UI state.
  function deriveCsvRows() {
    if (!state.csv) return [];
    let rows = state.csv.rows.slice();
    // Per-column filters (allowed-value sets)
    for (const [col, allowed] of state.csv.filters) {
      rows = rows.filter((r) => allowed.has((r[col] ?? "")));
    }
    // Global text filter — substring across visible columns
    const q = (state.csv.textFilter || "").toLowerCase();
    if (q && q.length >= 1) {
      const cols = visibleColIndices();
      rows = rows.filter((r) =>
        cols.some((ci) => String(r[ci] ?? "").toLowerCase().includes(q))
      );
    }
    // Sort (numeric if both compared values parse as numbers, locale otherwise)
    if (state.csv.sortBy) {
      const { col, dir } = state.csv.sortBy;
      const mult = dir === "asc" ? 1 : -1;
      rows.sort((a, b) => {
        const va = a[col] ?? "";
        const vb = b[col] ?? "";
        if (va === "" && vb === "") return 0;
        if (va === "") return 1; // empty values always sink
        if (vb === "") return -1;
        const na = Number(String(va).replace(/[,\s]/g, ""));
        const nb = Number(String(vb).replace(/[,\s]/g, ""));
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * mult;
        return String(va).localeCompare(String(vb), undefined, { sensitivity: "base" }) * mult;
      });
    }
    return rows;
  }

  function renderCsvIntoArticle() {
    if (!state.csv) return;
    closeFilterPopover();
    // The cols popover is anchored to a button we're about to recreate.
    // Toggle handlers reopen it against the freshly rendered button.
    closeColumnsPopover();
    const cols = visibleColIndices();
    const headers = state.csv.headers;
    const data = deriveCsvRows();
    const matched = data.length;
    const total = state.csv.rows.length;
    const sortInfo = state.csv.sortBy;

    // Precompute "is this column filtered?" so we can tag every cell in it.
    // Visual indicator works across the whole column (letter row, header, body).
    const filtered = new Set();
    for (const c of state.csv.filters.keys()) filtered.add(c);

    const html =
      `<div class="kindmd-csv">` +
        `<div class="kindmd-csv-toolbar">` +
          `<span class="kindmd-csv-meta">${matched.toLocaleString()} of ${total.toLocaleString()} rows · ${cols.length} of ${headers.length} columns</span>` +
          `<div class="kindmd-csv-actions">` +
            `<button class="kindmd-table-copy" type="button" data-copy-csv title="Copy table to clipboard (tab-separated)">Copy table</button>` +
            `<button class="kindmd-table-copy kindmd-csv-cols-btn" type="button" data-cols-menu aria-haspopup="dialog" aria-expanded="false" title="Show / hide columns">Columns <span class="kindmd-csv-cols-caret" aria-hidden="true">▾</span></button>` +
          `</div>` +
        `</div>` +
        `<div class="kindmd-csv-scroll" data-csv-scroll>` +
          `<table class="kindmd-csv-table" data-csv-table>` +
            `<thead>` +
              `<tr class="kindmd-csv-colletters">` +
                `<th class="kindmd-csv-corner" aria-hidden="true"></th>` +
                cols.map((ci) =>
                  `<th class="kindmd-csv-collabel${filtered.has(ci) ? " is-filtered" : ""}" data-col="${ci}">${escapeHtml(colLetter(ci))}</th>`
                ).join("") +
              `</tr>` +
              `<tr class="kindmd-csv-headers">` +
                `<th class="kindmd-csv-rownum-head" aria-hidden="true">#</th>` +
                cols.map((ci) => {
                  const sortDir = sortInfo && sortInfo.col === ci ? sortInfo.dir : null;
                  const sortGlyph = sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕";
                  const hasFilter = filtered.has(ci);
                  return `<th class="kindmd-csv-header${hasFilter ? " has-filter" : ""}${sortDir ? " is-sorted" : ""}${ci === cols[0] ? " is-first" : ""}" data-col="${ci}">` +
                    `<button class="kindmd-csv-sort" type="button" data-sort-col="${ci}" title="Sort">` +
                      `<span class="kindmd-csv-header-text">${escapeHtml(headers[ci] || "")}</span>` +
                      `<span class="kindmd-csv-sort-glyph" aria-hidden="true">${sortGlyph}</span>` +
                    `</button>` +
                    `<button class="kindmd-csv-filter-btn${hasFilter ? " is-active" : ""}" type="button" data-filter-col="${ci}" aria-label="${hasFilter ? "Edit column filter" : "Filter column"}" title="${hasFilter ? "Filter active — click to edit" : "Filter"}" aria-pressed="${hasFilter}">` +
                      `<span class="kindmd-csv-filter-glyph" aria-hidden="true">${hasFilter ? "⏷" : "▾"}</span>` +
                    `</button>` +
                  `</th>`;
                }).join("") +
              `</tr>` +
            `</thead>` +
            `<tbody>` +
              (data.length === 0
                ? `<tr><td class="kindmd-csv-empty" colspan="${cols.length + 1}">No rows match the current filters.</td></tr>`
                : data.map((row, ri) =>
                    `<tr>` +
                      `<th class="kindmd-csv-rownum" scope="row">${ri + 1}</th>` +
                      cols.map((ci, idx) =>
                        `<td class="kindmd-csv-cell${idx === 0 ? " is-first" : ""}${filtered.has(ci) ? " is-filtered" : ""}" data-col="${ci}">${escapeHtml(row[ci] ?? "")}</td>`
                      ).join("") +
                    `</tr>`
                  ).join("")
              ) +
            `</tbody>` +
          `</table>` +
        `</div>` +
      `</div>`;
    articleEl.innerHTML = html;
    wireCsvHandlers();
  }

  function wireCsvHandlers() {
    const tableEl = articleEl.querySelector("[data-csv-table]");
    if (!tableEl) return;
    // Header click → cycle sort (none → asc → desc → none).
    tableEl.querySelectorAll("[data-sort-col]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const col = Number(btn.getAttribute("data-sort-col"));
        const cur = state.csv.sortBy;
        if (!cur || cur.col !== col) {
          state.csv.sortBy = { col, dir: "asc" };
        } else if (cur.dir === "asc") {
          state.csv.sortBy = { col, dir: "desc" };
        } else {
          state.csv.sortBy = null;
        }
        renderCsvIntoArticle();
      });
    });
    // Filter dropdown
    tableEl.querySelectorAll("[data-filter-col]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const col = Number(btn.getAttribute("data-filter-col"));
        openFilterPopover(col, btn);
      });
    });
    // Copy
    const copyBtn = articleEl.querySelector("[data-copy-csv]");
    if (copyBtn) copyBtn.addEventListener("click", copyCsvTable);
    // Columns dropdown
    const colsBtn = articleEl.querySelector("[data-cols-menu]");
    if (colsBtn) {
      colsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.csv && state.csv.openColumnsPopover) {
          closeColumnsPopover();
        } else {
          openColumnsPopover(colsBtn);
        }
      });
    }
  }

  // ----- Columns dropdown (replaces TOC-pane manager) -----

  function closeColumnsPopover() {
    if (!state.csv) return;
    const pop = state.csv.openColumnsPopover;
    if (pop) {
      pop.remove();
      state.csv.openColumnsPopover = null;
    }
    const btn = articleEl.querySelector("[data-cols-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openColumnsPopover(anchorBtn) {
    closeColumnsPopover();
    closeFilterPopover();
    if (!state.csv) return;
    const headers = state.csv.headers;
    const items = headers.map((h, i) => {
      const checked = !state.csv.hiddenCols.has(i);
      return `<li class="kindmd-csv-col-item">` +
        `<label class="kindmd-csv-col-row">` +
          `<input type="checkbox" data-col-toggle="${i}"${checked ? " checked" : ""}>` +
          `<span class="kindmd-csv-col-letter">${escapeHtml(colLetter(i))}</span>` +
          `<span class="kindmd-csv-col-name">${escapeHtml(h || "")}</span>` +
        `</label>` +
      `</li>`;
    }).join("");
    const pop = document.createElement("div");
    pop.className = "kindmd-csv-cols-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Show or hide columns");
    pop.innerHTML =
      `<div class="kindmd-csv-cols-head">` +
        `<button type="button" class="kindmd-csv-filter-link" data-cols-all>Show all</button>` +
        `<span aria-hidden="true">·</span>` +
        `<button type="button" class="kindmd-csv-filter-link" data-cols-none>Hide all</button>` +
      `</div>` +
      `<ul class="kindmd-csv-cols-list">${items}</ul>`;
    document.body.appendChild(pop);
    state.csv.openColumnsPopover = pop;
    if (anchorBtn) anchorBtn.setAttribute("aria-expanded", "true");

    // Position the popover under the right edge of the button.
    const rect = anchorBtn.getBoundingClientRect();
    const w = 280;
    pop.style.width = w + "px";
    let left = Math.max(8, rect.right - w);
    let top = rect.bottom + 6;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    // Clamp to viewport.
    const pr = pop.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (pr.right > vw - 8) pop.style.left = Math.max(8, vw - w - 8) + "px";
    if (pr.bottom > vh - 8) pop.style.top = Math.max(8, rect.top - pr.height - 6) + "px";

    pop.querySelectorAll("input[data-col-toggle]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const idx = Number(cb.getAttribute("data-col-toggle"));
        if (cb.checked) state.csv.hiddenCols.delete(idx);
        else state.csv.hiddenCols.add(idx);
        // Re-render the table; reopen the popover anchored to the new button.
        renderCsvIntoArticle();
        const newAnchor = articleEl.querySelector("[data-cols-menu]");
        if (newAnchor) openColumnsPopover(newAnchor);
      });
    });
    pop.querySelector("[data-cols-all]")?.addEventListener("click", () => {
      state.csv.hiddenCols.clear();
      renderCsvIntoArticle();
      const newAnchor = articleEl.querySelector("[data-cols-menu]");
      if (newAnchor) openColumnsPopover(newAnchor);
    });
    pop.querySelector("[data-cols-none]")?.addEventListener("click", () => {
      // Keep at least column 0 visible so the table can't collapse fully.
      state.csv.hiddenCols = new Set(state.csv.headers.map((_, i) => i).filter((i) => i !== 0));
      renderCsvIntoArticle();
      const newAnchor = articleEl.querySelector("[data-cols-menu]");
      if (newAnchor) openColumnsPopover(newAnchor);
    });
  }

  // ----- Filter popover -----

  function closeFilterPopover() {
    if (!state.csv) return;
    if (state.csv.openFilterPopover) {
      state.csv.openFilterPopover.remove();
      state.csv.openFilterPopover = null;
    }
  }

  function openFilterPopover(col, anchorBtn) {
    closeFilterPopover();
    if (!state.csv) return;
    // Build set of unique non-null cell values in this column.
    const valuesMap = new Map();
    for (const r of state.csv.rows) {
      const v = r[col] ?? "";
      if (!valuesMap.has(v)) valuesMap.set(v, 0);
      valuesMap.set(v, valuesMap.get(v) + 1);
    }
    const allValues = Array.from(valuesMap.keys()).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    });
    const allowed = state.csv.filters.get(col) || new Set(allValues);
    const isAllSelected = !state.csv.filters.has(col);

    const pop = document.createElement("div");
    pop.className = "kindmd-csv-filter-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Filter column");
    pop.innerHTML =
      `<div class="kindmd-csv-filter-search">` +
        `<input type="search" placeholder="Filter values…" data-filter-search autocomplete="off" spellcheck="false">` +
      `</div>` +
      `<div class="kindmd-csv-filter-actions">` +
        `<button type="button" class="kindmd-csv-filter-link" data-filter-all>Select all</button>` +
        `<span aria-hidden="true">·</span>` +
        `<button type="button" class="kindmd-csv-filter-link" data-filter-none>Clear</button>` +
      `</div>` +
      `<ul class="kindmd-csv-filter-list" data-filter-list></ul>` +
      `<div class="kindmd-csv-filter-foot">` +
        `<button type="button" class="kindmd-csv-filter-cancel" data-filter-cancel>Cancel</button>` +
        `<button type="button" class="kindmd-csv-filter-apply" data-filter-apply>Apply</button>` +
      `</div>`;
    document.body.appendChild(pop);
    state.csv.openFilterPopover = pop;

    // Position next to the anchor button
    const rect = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.max(8, rect.left - 4) + "px";
    pop.style.top = (rect.bottom + 4) + "px";
    // Clamp to viewport
    const pr = pop.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (pr.right > vw - 8) pop.style.left = Math.max(8, vw - pr.width - 8) + "px";
    if (pr.bottom > vh - 8) pop.style.top = Math.max(8, vh - pr.height - 8) + "px";

    const listEl = pop.querySelector("[data-filter-list]");
    const searchInputEl = pop.querySelector("[data-filter-search]");
    let workingAllowed = new Set(allowed);
    let workingAllSelected = isAllSelected;

    function renderList(filterText) {
      const q = (filterText || "").toLowerCase();
      const items = allValues.filter((v) => !q || String(v).toLowerCase().includes(q));
      const listHtml = items.map((v) => {
        const checked = workingAllSelected || workingAllowed.has(v);
        const label = v === "" ? "(blank)" : String(v);
        return `<li><label class="kindmd-csv-filter-item">` +
          `<input type="checkbox" data-filter-value="${escapeHtml(String(v))}"${checked ? " checked" : ""}>` +
          `<span class="kindmd-csv-filter-label">${escapeHtml(label)}</span>` +
          `<span class="kindmd-csv-filter-count">${valuesMap.get(v)}</span>` +
          `</label></li>`;
      }).join("");
      listEl.innerHTML = listHtml || `<li class="kindmd-csv-filter-empty">No matching values</li>`;
      listEl.querySelectorAll("input[data-filter-value]").forEach((cb) => {
        cb.addEventListener("change", () => {
          // First interaction collapses "all selected" into an explicit set.
          if (workingAllSelected) {
            workingAllSelected = false;
            workingAllowed = new Set(allValues);
          }
          const val = cb.getAttribute("data-filter-value");
          // Decoded back from escaped HTML — for safety, use direct attribute
          // but realistic CSV values shouldn't include HTML entities anyway.
          if (cb.checked) workingAllowed.add(val);
          else workingAllowed.delete(val);
        });
      });
    }
    renderList("");

    searchInputEl.addEventListener("input", () => renderList(searchInputEl.value));
    pop.querySelector("[data-filter-all]").addEventListener("click", () => {
      workingAllSelected = true;
      workingAllowed = new Set(allValues);
      renderList(searchInputEl.value);
    });
    pop.querySelector("[data-filter-none]").addEventListener("click", () => {
      workingAllSelected = false;
      workingAllowed = new Set();
      renderList(searchInputEl.value);
    });
    pop.querySelector("[data-filter-cancel]").addEventListener("click", closeFilterPopover);
    pop.querySelector("[data-filter-apply]").addEventListener("click", () => {
      if (workingAllSelected || workingAllowed.size === allValues.length) {
        state.csv.filters.delete(col);
      } else {
        state.csv.filters.set(col, workingAllowed);
      }
      closeFilterPopover();
      renderCsvIntoArticle();
    });
    setTimeout(() => searchInputEl.focus(), 0);
  }

  // Clicking elsewhere or pressing Escape dismisses any open popover.
  document.addEventListener("mousedown", (e) => {
    if (!state.csv) return;
    if (state.csv.openFilterPopover && !state.csv.openFilterPopover.contains(e.target) && !e.target.closest("[data-filter-col]")) {
      closeFilterPopover();
    }
    if (state.csv.openColumnsPopover && !state.csv.openColumnsPopover.contains(e.target) && !e.target.closest("[data-cols-menu]")) {
      closeColumnsPopover();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.csv) return;
    if (state.csv.openFilterPopover) closeFilterPopover();
    if (state.csv.openColumnsPopover) closeColumnsPopover();
  });

  // ----- Copy table to clipboard (TSV) -----

  function rowsToTsv(headerCells, rowCells) {
    // Escape any tab/newline to keep the TSV grid intact. Spreadsheets won't
    // re-import literal tabs inside cells without quoting; we replace them.
    const esc = (v) => String(v ?? "").replace(/\t/g, "    ").replace(/\r?\n/g, " ");
    const lines = [];
    if (headerCells && headerCells.length) lines.push(headerCells.map(esc).join("\t"));
    for (const r of rowCells) lines.push(r.map(esc).join("\t"));
    return lines.join("\n");
  }

  async function copyCsvTable() {
    if (!state.csv) return;
    const cols = visibleColIndices();
    const headerCells = cols.map((ci) => state.csv.headers[ci] || "");
    const rows = deriveCsvRows().map((r) => cols.map((ci) => r[ci] ?? ""));
    const tsv = rowsToTsv(headerCells, rows);
    await kindmd.copyToClipboard(tsv);
    flashMessage(`Copied ${rows.length.toLocaleString()} rows`);
  }

  // ----- Copy buttons on rendered markdown tables -----

  function attachCopyButtonsToTables(root) {
    if (!root) return;
    const wraps = root.querySelectorAll(".kindmd-table-wrap");
    wraps.forEach((wrap) => {
      if (wrap.querySelector(".kindmd-table-copy")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kindmd-table-copy is-floating";
      btn.title = "Copy table to clipboard (tab-separated)";
      btn.textContent = "Copy";
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const table = wrap.querySelector("table");
        if (!table) return;
        const headerCells = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
        const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
          Array.from(tr.querySelectorAll("td, th")).map((c) => c.textContent.trim())
        );
        const tsv = rowsToTsv(headerCells.length ? headerCells : null, rows);
        await kindmd.copyToClipboard(tsv);
        flashMessage(`Copied ${rows.length.toLocaleString()} rows`);
      });
      wrap.appendChild(btn);
    });
  }

  // Nothing else lives in the TOC pane in CSV mode — the right pane is hidden
  // via the kindmd-csv-active body class.
  function restoreTocTitle() {
    const titleEl2 = tocPaneEl?.querySelector(".kindmd-toc-title");
    if (titleEl2) titleEl2.textContent = "Contents";
  }

  // ---------- Edit mode ----------

  // Slugify must match what render.js produces so the active id we set on the
  // TOC matches the link's data-toc-target.
  function slugifyHeading(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  // ---------- Edit-mode TOC scroll spy ----------

  let editScrollHandler = null;
  let editScrollRaf = 0;

  function startEditScrollSpy() {
    stopEditScrollSpy();
    const main = document.querySelector(".kindmd-app-main");
    if (!main || !editTextarea || !tocEl) return;
    editScrollHandler = () => {
      if (editScrollRaf) return;
      editScrollRaf = requestAnimationFrame(() => {
        editScrollRaf = 0;
        updateEditTocActive();
      });
    };
    main.addEventListener("scroll", editScrollHandler, { passive: true });
    // Initial paint
    updateEditTocActive();
  }

  function stopEditScrollSpy() {
    const main = document.querySelector(".kindmd-app-main");
    if (main && editScrollHandler) {
      main.removeEventListener("scroll", editScrollHandler);
    }
    editScrollHandler = null;
    if (editScrollRaf) cancelAnimationFrame(editScrollRaf);
    editScrollRaf = 0;
  }

  function updateEditTocActive() {
    if (!state.editMode || !editTextarea || !tocEl) return;
    const main = document.querySelector(".kindmd-app-main");
    if (!main) return;
    // Parse H2 lines from the textarea source. We only spy on H2 because the
    // TOC is built from H2 only.
    const lines = editTextarea.value.split("\n");
    const headings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(##)\s+(.+?)(?:\s*\{[^}]*\})?\s*$/);
      if (m) {
        headings.push({ lineIdx: i, text: m[2].trim(), id: slugifyHeading(m[2].trim()) });
      }
    }
    if (!headings.length) return;

    const masthead = document.querySelector(".kindmd-app-titlebar");
    const mastheadH = masthead ? masthead.offsetHeight : 70;
    const cs = window.getComputedStyle(editTextarea);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.7);
    const taOffsetInMain =
      (editTextarea.getBoundingClientRect().top - main.getBoundingClientRect().top) + main.scrollTop;
    // A heading is "active" if its top has scrolled past the masthead.
    const threshold = main.scrollTop + mastheadH + 32;
    let activeId = headings[0].id;
    for (const h of headings) {
      const lineY = taOffsetInMain + lh * h.lineIdx;
      if (lineY <= threshold) activeId = h.id;
      else break;
    }
    tocEl.querySelectorAll("a[data-toc-target]").forEach((a) => {
      if (a.getAttribute("data-toc-target") === activeId) a.setAttribute("aria-current", "location");
      else a.removeAttribute("aria-current");
    });
  }

  function enterEditMode() {
    if (!state.currentFile) return;
    if (state.editMode) return;
    state.editMode = true;
    document.body.classList.add("kindmd-edit-active");
    // Toggle visibility via the hidden attribute — single source of truth.
    articleEl.hidden = true;
    editPane.hidden = false;
    if (editHints) editHints.hidden = false;
    editTextarea.value = state.currentRaw || "";
    state.dirty = false;
    setDirtyIndicator(false);
    if (editToggleBtn) {
      editToggleBtn.setAttribute("aria-pressed", "true");
      editLabel.textContent = "Read";
    }
    updateActionButton();
    // Pause file watcher while editing so we don't fight the user mid-keystroke.
    kindmd.unwatchFile();
    // Reset the main pane's scroll so the editor sits flush under the masthead
    // rather than at whatever scrollTop the article happened to be at.
    const mainEl = document.querySelector(".kindmd-app-main");
    if (mainEl) mainEl.scrollTop = 0;
    // Clear any read-mode search highlights — they're in the now-hidden article.
    clearSearchHighlights();
    // Focus and restore cursor at start.
    requestAnimationFrame(() => {
      editTextarea.focus();
      editTextarea.setSelectionRange(0, 0);
      editTextarea.scrollTop = 0;
      // If there's an active search query, run it against the source.
      if (searchInput && searchInput.value.trim().length >= 2) {
        runSearch(searchInput.value);
      }
      // TOC scroll-spy keeps the right pane in sync as the user scrolls.
      startEditScrollSpy();
    });
  }

  async function exitEditMode(opts = {}) {
    const { skipSave = false } = opts;
    if (!state.editMode) return;
    if (!skipSave && state.dirty) {
      await saveEdits({ silent: true });
    }
    state.editMode = false;
    stopEditScrollSpy();
    document.body.classList.remove("kindmd-edit-active");
    editPane.hidden = true;
    articleEl.hidden = false;
    if (editHints) editHints.hidden = true;
    if (editToggleBtn) {
      editToggleBtn.setAttribute("aria-pressed", "false");
      editLabel.textContent = "Edit";
    }
    updateActionButton();
    // Drop any edit-mode match state — it's textarea ranges, not DOM marks.
    state.searchMatches = [];
    state.searchIndex = -1;
    // Re-run an active search against the rendered article.
    if (searchInput && searchInput.value.trim().length >= 2) {
      runSearch(searchInput.value);
    } else {
      updateSearchCount();
    }
    // Resume watching the file (saveEdits / writeMd closes the watcher).
    if (state.currentFile) kindmd.watchFile(state.currentFile);
  }

  async function saveEdits(opts = {}) {
    const { silent = false } = opts;
    if (!state.currentFile) return { ok: false };
    const content = editTextarea.value;
    const result = await kindmd.writeMd(state.currentFile, content);
    if (result && result.ok) {
      state.currentRaw = content;
      state.dirty = false;
      setDirtyIndicator(false);
      if (!silent) flashMessage("Saved");
      // Re-render in the background so the article reflects the saved content
      // even while we stay in edit mode.
      const rendered = await kindmd.renderString(content, basename(state.currentFile).replace(/\.md$/i, ""));
      if (rendered && rendered.ok) {
        const doc = rendered.doc;
        state.currentDoc = { ...state.currentDoc, ...doc, modifiedAt: result.modifiedAt || state.currentDoc?.modifiedAt };
        titleEl.textContent = doc.title;
        document.title = `${doc.title} — kindmd`;
        articleEl.innerHTML = doc.html;
        injectColorSwatches(articleEl);
        attachCopyButtonsToTables(articleEl);
        rebuildToc(doc.toc);
        wireSectionToggles();
        restoreSectionCollapse();
        wireInternalLinks();
        rebuildTocObserver();
        if (footerModified) footerModified.textContent = formatModified(result.modifiedAt);
      }
      return result;
    }
    flashMessage("Save failed");
    return result || { ok: false };
  }

  function setDirtyIndicator(isDirty) {
    if (!editDirtyDot) return;
    editDirtyDot.hidden = !isDirty;
  }

  if (editToggleBtn) {
    editToggleBtn.addEventListener("click", () => {
      if (state.editMode) exitEditMode();
      else enterEditMode();
    });
  }

  if (editTextarea) {
    editTextarea.addEventListener("input", () => {
      if (state.editMode && editTextarea.value !== state.currentRaw) {
        if (!state.dirty) { state.dirty = true; setDirtyIndicator(true); }
      } else if (state.dirty && editTextarea.value === state.currentRaw) {
        state.dirty = false;
        setDirtyIndicator(false);
      }
      // Heading positions may shift as the user types — refresh TOC active state.
      if (state.editMode) updateEditTocActive();
    });

    // Tab inserts two spaces rather than escaping focus — common editor expectation.
    editTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const start = editTextarea.selectionStart;
        const end = editTextarea.selectionEnd;
        const v = editTextarea.value;
        editTextarea.value = v.slice(0, start) + "  " + v.slice(end);
        editTextarea.setSelectionRange(start + 2, start + 2);
        editTextarea.dispatchEvent(new Event("input"));
      } else if (e.key === "Escape") {
        e.preventDefault();
        exitEditMode();
      }
    });
  }

  function formatModified(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  }

  function rebuildToc(toc) {
    restoreTocTitle();
    if (!toc || !toc.length) {
      tocEl.innerHTML = `<p class="kindmd-toc-empty"><em>No sections.</em></p>`;
      return;
    }
    const ol = document.createElement("ol");
    ol.className = "kindmd-toc-list";
    for (const { id, text, num } of toc) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + id;
      a.setAttribute("data-toc-target", id);
      a.innerHTML = `<span class="kindmd-toc-num">${escapeHtml(num)}</span><span class="kindmd-toc-text">${escapeHtml(text)}</span>`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToHeading(id);
      });
      li.appendChild(a);
      ol.appendChild(li);
    }
    tocEl.innerHTML = "";
    tocEl.appendChild(ol);
  }

  function scrollToHeading(id) {
    // In edit mode the rendered article is hidden, so navigate the textarea
    // by finding the corresponding `##` line in the raw markdown.
    if (state.editMode) {
      return scrollToHeadingInEditor(id);
    }
    const target = document.getElementById(id);
    if (!target) return;
    const section = target.closest(".kindmd-section");
    if (section && section.classList.contains("is-collapsed")) toggleSection(section, false);
    target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", "#" + id);
  }

  function getTocText(id) {
    if (!tocEl) return null;
    const link = tocEl.querySelector(`a[data-toc-target="${cssEscape(id)}"]`);
    if (!link) return null;
    const textEl = link.querySelector(".kindmd-toc-text");
    return textEl ? textEl.textContent : null;
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function findHeadingLineInSource(text) {
    if (!editTextarea || !text) return null;
    const target = String(text).trim();
    const value = editTextarea.value;
    const lines = value.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // `## Heading`, optionally followed by `{.class #id …}` attributes.
      const m = line.match(/^(#{2,6})\s+(.+?)(?:\s*\{[^}]*\})?\s*$/);
      if (m && m[2].trim() === target) {
        return { lineIdx: i, charOffset: offset, lineLength: line.length };
      }
      offset += line.length + 1; // +1 for the newline
    }
    return null;
  }

  function scrollMainToTextareaLine(lineIdx) {
    const main = document.querySelector(".kindmd-app-main");
    if (!main || !editTextarea) return;
    const masthead = document.querySelector(".kindmd-app-titlebar");
    const mastheadH = masthead ? masthead.offsetHeight : 70;
    const cs = window.getComputedStyle(editTextarea);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.7);
    const taOffsetInMain =
      (editTextarea.getBoundingClientRect().top - main.getBoundingClientRect().top) + main.scrollTop;
    const targetY = taOffsetInMain + lh * lineIdx;
    const top = Math.max(0, targetY - mastheadH - 16);
    main.scrollTo({
      top,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  function scrollToHeadingInEditor(id) {
    const text = getTocText(id);
    if (!text) return;
    const hit = findHeadingLineInSource(text);
    if (!hit) return;
    // Place the caret at the start of the heading line and reflect "current".
    editTextarea.focus({ preventScroll: true });
    editTextarea.setSelectionRange(hit.charOffset, hit.charOffset);
    scrollMainToTextareaLine(hit.lineIdx);
    // Mirror the active state on the TOC immediately (no IntersectionObserver in edit mode).
    if (tocEl) {
      tocEl.querySelectorAll("a[data-toc-target]").forEach((a) => {
        if (a.getAttribute("data-toc-target") === id) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
    }
  }

  // ---------- TOC scroll-spy ----------

  let tocObserver = null;
  function rebuildTocObserver() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    const headings = Array.from(articleEl.querySelectorAll("h2.kindmd-h2"));
    if (!headings.length) return;
    const mainEl = document.querySelector(".kindmd-app-main");
    tocObserver = new IntersectionObserver(() => {
      let topId = null;
      let topY = Infinity;
      for (const h of headings) {
        const rect = h.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.45 && rect.top > -rect.height) {
          if (rect.top < topY) { topY = rect.top; topId = h.id; }
        }
      }
      if (!topId) {
        for (const h of headings) {
          const r = h.getBoundingClientRect();
          if (r.top <= 100) topId = h.id; else break;
        }
      }
      tocEl.querySelectorAll("a[data-toc-target]").forEach((a) => {
        if (a.getAttribute("data-toc-target") === topId) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
    }, { root: mainEl, rootMargin: "-80px 0px -55% 0px", threshold: [0, 0.5, 1] });
    headings.forEach((h) => tocObserver.observe(h));
  }

  // ---------- Section collapse ----------

  function toggleSection(section, force) {
    const willCollapse = typeof force === "boolean" ? force : !section.classList.contains("is-collapsed");
    section.classList.toggle("is-collapsed", willCollapse);
    const btn = section.querySelector(".kindmd-section-toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!willCollapse));
      const label = btn.querySelector(".kindmd-section-label");
      if (label) {
        const expandedText = label.getAttribute("data-label-expanded") || "Collapse";
        const collapsedText = label.getAttribute("data-label-collapsed") || "Expand";
        label.textContent = willCollapse ? collapsedText : expandedText;
      }
    }
    persistSectionCollapse();
  }

  function persistSectionCollapse() {
    if (!state.currentFile) return;
    const sections = Array.from(articleEl.querySelectorAll(".kindmd-section"));
    const collapsed = {};
    for (const s of sections) {
      const id = s.getAttribute("data-section-id");
      if (id && s.classList.contains("is-collapsed")) collapsed[id] = true;
    }
    state.sectionCollapseByFile[state.currentFile] = collapsed;
    lsSet("kindmd:app:section-collapsed", state.sectionCollapseByFile);
  }

  function restoreSectionCollapse() {
    if (!state.currentFile) return;
    const map = state.sectionCollapseByFile[state.currentFile] || {};
    articleEl.querySelectorAll(".kindmd-section").forEach((s) => {
      const id = s.getAttribute("data-section-id");
      if (id && map[id]) toggleSection(s, true);
    });
  }

  function wireSectionToggles() {
    articleEl.querySelectorAll(".kindmd-section-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const section = btn.closest(".kindmd-section");
        if (section) toggleSection(section);
      });
    });
  }

  // ---------- Internal links ----------

  function wireInternalLinks() {
    if (!state.currentFile) return;
    const dirParts = state.currentFile.split("/");
    dirParts.pop();
    const baseDir = dirParts.join("/");
    const links = articleEl.querySelectorAll("a.kindmd-link-internal, a.kindmd-link-external, a.kindmd-link-anchor");
    links.forEach((a) => {
      const href = a.getAttribute("data-kindmd-href") || a.getAttribute("href") || "";
      if (a.classList.contains("kindmd-link-external")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          kindmd.openExternal(href);
        });
      } else if (a.classList.contains("kindmd-link-anchor")) {
        a.addEventListener("click", (e) => {
          e.preventDefault();
          const id = href.replace(/^#/, "");
          scrollToHeading(id);
        });
      } else if (a.classList.contains("kindmd-link-internal") && href) {
        a.addEventListener("click", async (e) => {
          e.preventDefault();
          const [rel, hash] = href.split("#");
          const target = resolvePath(baseDir, rel);
          if (/\.md$/i.test(target)) {
            await loadDocument(target);
            if (hash) scrollToHeading(hash);
          } else {
            // Non-markdown file: reveal in Finder
            kindmd.showInFinder(target);
          }
        });
      }
    });
  }

  function resolvePath(base, rel) {
    const parts = (base + "/" + rel).split("/");
    const out = [];
    for (const p of parts) {
      if (p === "" && out.length) continue;
      if (p === ".") continue;
      if (p === "..") { out.pop(); continue; }
      out.push(p);
    }
    return out.join("/");
  }

  // ---------- Search ----------

  function clearSearchHighlights() {
    const marks = articleEl.querySelectorAll(".kindmd-search-mark");
    marks.forEach((m) => {
      const parent = m.parentNode;
      if (!parent) return;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
    state.searchMatches = [];
    state.searchIndex = -1;
  }

  function runSearch(query) {
    // Search must work in both modes — dispatch by current view.
    if (state.editMode) return runSearchInEditor(query);
    if (state.currentFileKind === "csv") return runSearchInCsv(query);
    clearSearchHighlights();
    if (!query || query.length < 2) {
      searchCount.textContent = "";
      return;
    }
    const q = query.toLowerCase();
    const matches = [];
    const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let p = node.parentNode;
        while (p && p !== articleEl) {
          if (p.tagName === "SCRIPT" || p.tagName === "STYLE") return NodeFilter.FILTER_REJECT;
          if (p.classList && p.classList.contains("kindmd-search-mark")) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return node.nodeValue.toLowerCase().includes(q) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const node of textNodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let from = 0;
      const frag = document.createDocumentFragment();
      let idx;
      const localMarks = [];
      while ((idx = lower.indexOf(q, from)) !== -1) {
        if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
        const mark = document.createElement("mark");
        mark.className = "kindmd-search-mark";
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        localMarks.push(mark);
        from = idx + q.length;
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
      matches.push(...localMarks);
    }

    state.searchMatches = matches;
    state.searchIndex = matches.length ? 0 : -1;
    updateSearchCount();
    if (matches.length) focusMatch(0);
  }

  function updateSearchCount() {
    if (state.searchMatches.length === 0) {
      const v = searchInput.value.trim();
      if (v && v.length >= 2) {
        searchCount.textContent = "No matches";
        searchCount.classList.add("is-empty");
      } else {
        searchCount.textContent = "";
        searchCount.classList.remove("is-empty");
      }
    } else {
      searchCount.classList.remove("is-empty");
      searchCount.textContent = `${state.searchIndex + 1} of ${state.searchMatches.length}`;
    }
  }

  function focusMatch(idx) {
    if (!state.searchMatches.length) return;
    if (state.editMode) return focusMatchInEditor(idx);
    state.searchMatches.forEach((m, i) => {
      if (m && m.classList) m.classList.toggle("is-current", i === idx);
    });
    state.searchIndex = idx;
    const mark = state.searchMatches[idx];
    if (!mark || !mark.closest) return;
    const section = mark.closest(".kindmd-section");
    if (section && section.classList.contains("is-collapsed")) toggleSection(section, false);
    mark.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    });
    updateSearchCount();
  }

  // ---------- Search in CSV mode (row filter) ----------

  function runSearchInCsv(query) {
    if (!state.csv) return;
    state.csv.textFilter = (query || "").trim();
    renderCsvIntoArticle();
    // Show "<matched> of <total>" in the search-count slot.
    const total = state.csv.rows.length;
    let matched = total;
    if (state.csv.textFilter) {
      matched = deriveCsvRows().length;
    } else {
      // re-apply per-column filters only to get count
      matched = deriveCsvRows().length;
    }
    if (searchCount) {
      if (!state.csv.textFilter) {
        searchCount.textContent = "";
        searchCount.classList.remove("is-empty");
      } else if (matched === 0) {
        searchCount.textContent = "No matches";
        searchCount.classList.add("is-empty");
      } else {
        searchCount.textContent = `${matched.toLocaleString()} of ${total.toLocaleString()}`;
        searchCount.classList.remove("is-empty");
      }
    }
  }

  // ---------- Search in edit mode ----------

  function runSearchInEditor(query) {
    state.searchMatches = [];
    state.searchIndex = -1;
    if (!query || query.length < 2) {
      updateSearchCount();
      // Clear textarea selection
      if (editTextarea) {
        const pos = editTextarea.selectionStart;
        editTextarea.setSelectionRange(pos, pos);
      }
      return;
    }
    if (!editTextarea) return;
    const text = editTextarea.value;
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    const matches = [];
    let from = 0;
    let idx;
    while ((idx = lower.indexOf(q, from)) !== -1) {
      matches.push({ start: idx, end: idx + q.length });
      from = idx + q.length;
    }
    state.searchMatches = matches;
    state.searchIndex = matches.length ? 0 : -1;
    updateSearchCount();
    if (matches.length) focusMatchInEditor(0);
  }

  function focusMatchInEditor(idx) {
    const m = state.searchMatches[idx];
    if (!m || typeof m.start !== "number") return;
    state.searchIndex = idx;
    editTextarea.focus({ preventScroll: true });
    editTextarea.setSelectionRange(m.start, m.end);
    const before = editTextarea.value.slice(0, m.start);
    const lineIdx = (before.match(/\n/g) || []).length;
    scrollMainToTextareaLine(lineIdx);
    updateSearchCount();
  }

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(searchInput.value), 120);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // In CSV mode the search box is a row filter, not a match cursor.
      if (state.currentFileKind === "csv") return;
      if (!state.searchMatches.length) return;
      const next = e.shiftKey
        ? (state.searchIndex - 1 + state.searchMatches.length) % state.searchMatches.length
        : (state.searchIndex + 1) % state.searchMatches.length;
      focusMatch(next);
    } else if (e.key === "Escape") {
      searchInput.value = "";
      if (state.currentFileKind === "csv") {
        runSearchInCsv("");
      } else {
        clearSearchHighlights();
        updateSearchCount();
      }
      searchInput.blur();
    }
  });

  document.addEventListener("keydown", (e) => {
    // Cmd-S saves while in edit mode
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      if (state.editMode) {
        e.preventDefault();
        saveEdits();
        return;
      }
    }
    // Cmd-E toggles edit mode (in addition to clicking the button).
    // CSV files are view-only in v1, so the shortcut is a no-op for them.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && !e.shiftKey) {
      if (state.currentFile && state.currentFileKind !== "csv") {
        e.preventDefault();
        if (state.editMode) exitEditMode();
        else enterEditMode();
      }
      return;
    }
    // Cmd-F or Cmd-K always focus search — works in both Read and Edit modes.
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "k")) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // ---------- Export (read mode) / Save As… (edit mode) ----------

  function updateActionButton() {
    if (!exportBtn) return;
    if (state.editMode) {
      exportBtn.textContent = "Save as…";
      exportBtn.setAttribute("aria-label", "Save markdown as a new file");
    } else {
      exportBtn.textContent = "Export";
      exportBtn.setAttribute("aria-label", "Export as HTML");
    }
  }

  exportBtn.addEventListener("click", () => {
    if (state.editMode) saveAsCurrent();
    else if (state.currentFileKind === "csv") exportCsvCurrent();
    else exportCurrent();
  });

  async function exportCsvCurrent() {
    if (!state.csv) return;
    const tableHtml = articleEl.querySelector(".kindmd-csv-scroll");
    if (!tableHtml) return;
    const styleHrefs = ["../client/styles.css", "./app.css"];
    const styles = [];
    for (const href of styleHrefs) {
      try {
        const r = await fetch(href);
        if (r.ok) styles.push(await r.text());
      } catch { /* ignore */ }
    }
    const safeTitle = (state.currentDoc?.title || "table").replace(/[^a-z0-9\-_.]+/gi, "-").replace(/^-+|-+$/g, "") || "table";
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(state.currentDoc?.title || "Table")}</title>
<style>
${styles.join("\n\n")}
</style>
</head>
<body class="kindmd-mode-file">
<main class="kindmd-app-main"><article class="kindmd-article kindmd-csv-active">${tableHtml.outerHTML}</article></main>
</body>
</html>`;
    const result = await kindmd.exportHtml({ html, suggestedName: safeTitle });
    if (result && result.ok) flashMessage(`Exported to ${basename(result.path)}`);
  }

  async function saveAsCurrent() {
    if (!editTextarea) return;
    const content = editTextarea.value;
    const currentName = state.currentFile
      ? state.currentFile.split("/").pop()
      : "untitled.md";
    const dotIdx = currentName.lastIndexOf(".");
    const base = dotIdx > 0 ? currentName.slice(0, dotIdx) : currentName;
    const ext = dotIdx > 0 ? currentName.slice(dotIdx) : ".md";
    const defaultName = `${base} copy${ext}`;
    const parent = state.currentFile
      ? state.currentFile.split("/").slice(0, -1).join("/")
      : (state.rootFolder || "");
    const defaultPath = parent ? `${parent}/${defaultName}` : defaultName;

    const result = await kindmd.saveMdAs({ content, defaultPath });
    if (!result) return;
    if (result.canceled) return;
    if (!result.ok) {
      flashMessage(`Save as failed: ${result.error || "unknown"}`);
      return;
    }
    // Update sidebar root if the new file is outside the current root.
    const newDir = result.path.split("/").slice(0, -1).join("/");
    if (!state.rootFolder || !result.path.startsWith(state.rootFolder + "/")) {
      await setRootFolder(newDir);
    } else {
      await loadAndRenderRoot();
    }
    // Open the new file and keep the user in edit mode.
    await loadDocument(result.path);
    enterEditMode();
    flashMessage(`Saved → ${result.path.split("/").pop()}`);
  }

  async function exportCurrent() {
    if (!state.currentDoc) return;
    // Snapshot current DOM with inlined assets
    const styleHrefs = ["../client/styles.css", "./app.css"];
    const styles = [];
    for (const href of styleHrefs) {
      try {
        const r = await fetch(href);
        if (r.ok) styles.push(await r.text());
      } catch { /* ignore */ }
    }
    const doc = state.currentDoc;
    const safe = (doc.title || "document").replace(/[^a-z0-9\-_]+/gi, "-").replace(/^-+|-+$/g, "") || "document";

    const html = `<!doctype html>
<html lang="${escapeHtml(doc.language || "en")}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
${styles.join("\n\n")}
</style>
</head>
<body class="kindmd-mode-file">
<header class="kindmd-masthead">
  <div class="kindmd-masthead-inner">
    <span class="kindmd-brand"><span class="kindmd-brand-mark">kind<span class="kindmd-brand-dot">·</span>md</span></span>
    <h1 class="kindmd-title">${escapeHtml(doc.title)}</h1>
  </div>
</header>
<main class="kindmd-app-main"><article class="kindmd-article">${doc.html}</article></main>
</body>
</html>`;

    const result = await kindmd.exportHtml({ html, suggestedName: safe });
    if (result && result.ok) {
      flashMessage(`Exported to ${basename(result.path)}`);
    }
  }

  function flashMessage(text) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "position:fixed;bottom:24px;right:24px;background:var(--ink);color:var(--paper);padding:10px 16px;border-radius:6px;font-family:var(--font-mono);font-size:12px;letter-spacing:0.04em;box-shadow:0 4px 16px rgba(0,0,0,0.2);z-index:100;opacity:0;transition:opacity 0.2s ease;";
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, 1800);
  }

  // ---------- Buttons in welcome state ----------

  document.body.addEventListener("click", (e) => {
    const folderBtn = e.target.closest("[data-open-folder]");
    if (folderBtn) { kindmd.requestFolder(); return; }
    const fileBtn = e.target.closest("[data-open-file]");
    if (fileBtn) { kindmd.requestFile(); return; }
  });

  // ---------- IPC subscriptions ----------

  kindmd.onFolderOpened((folderPath) => { setRootFolder(folderPath); });

  kindmd.onFileOpened(async (filePath) => {
    initialFileHandled = true;
    if (!state.rootFolder) {
      const dir = filePath.split("/").slice(0, -1).join("/");
      await setRootFolder(dir);
    }
    loadDocument(filePath);
  });

  kindmd.onFileChanged((changedPath) => {
    if (changedPath === state.currentFile) {
      // Reset CSV UI state so a changed file shows fresh — filters tied to
      // the old data shape wouldn't make sense after a column add/remove.
      if (state.currentFileKind === "csv") state.csv = null;
      loadDocument(state.currentFile, { preserveScroll: true });
    }
  });

  kindmd.onToggleSidebar(() => {
    const hidden = appEl.getAttribute("data-sidebar-hidden") === "true";
    appEl.setAttribute("data-sidebar-hidden", String(!hidden));
  });

  kindmd.onToggleToc(() => {
    const hidden = appEl.getAttribute("data-toc-hidden") === "true";
    appEl.setAttribute("data-toc-hidden", String(!hidden));
  });

  kindmd.onFocusSearch(() => {
    searchInput.focus();
    searchInput.select();
  });

  // ---------- Launch routing ----------
  // Two cases:
  //   1. Launched by macOS to open a specific .md (Finder double-click,
  //      "Open With…", drag-onto-dock). Main process has cached the path via
  //      the `open-file` event before the window was even created.
  //      → load that file directly.
  //   2. Launched standalone (Dock, Spotlight, /usr/bin/open kindmd.app).
  //      → immediately show the folder picker, pre-filled with the last
  //      folder we worked in. No auto-restore of the previous document —
  //      the picker is the explicit "where are we today" prompt.

  let initialFileHandled = false;

  (async function init() {
    // Give macOS / Electron a moment to deliver any pending open-file event
    // before we decide it's a cold-launch-without-file. Without this, the
    // event can race with our first getState() and we'd fall to the folder
    // picker even though Finder did pass a file.
    await new Promise((r) => setTimeout(r, 200));
    const st = await kindmd.getState();
    if (st && st.lastOpenedFile) {
      initialFileHandled = true;
      const folder = st.lastOpenedFolder || st.lastOpenedFile.split("/").slice(0, -1).join("/");
      if (folder) await setRootFolder(folder);
      await loadDocument(st.lastOpenedFile);
      return;
    }
    // If a file-opened IPC raced in while we were awaiting, it'll have
    // flipped this flag — bail out and let that handler do its thing.
    if (initialFileHandled) return;
    // No file from macOS — prompt for a folder. Pre-fill with last folder.
    const lastFolder = lsGet("kindmd:app:last-folder", null);
    await kindmd.requestFolder(lastFolder || undefined);
  })();

  // Persist current folder/file
  setInterval(() => {
    if (state.rootFolder) lsSet("kindmd:app:last-folder", state.rootFolder);
    if (state.currentFile) lsSet("kindmd:app:last-file", state.currentFile);
  }, 2000);

})();
