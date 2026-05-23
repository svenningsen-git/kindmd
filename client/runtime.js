/* kindmd v1 client runtime. No dependencies. */
(function () {
  "use strict";

  const bootEl = document.getElementById("kindmd-boot");
  const BOOT = bootEl ? JSON.parse(bootEl.textContent) : { mode: "file", initialDoc: {} };
  const MODE = BOOT.mode;
  const FOLDER_KEY = MODE === "folder" ? location.host + location.pathname.split("/")[0] : "";

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

  function sectionCollapseKey(path) {
    return `kindmd:section-collapsed:${path || "file"}`;
  }
  function treeCollapseKey() {
    return `kindmd:tree-collapsed:${location.host}`;
  }

  // ---------- State ----------
  const state = {
    currentPath: BOOT.docPath || "",
    currentDoc: BOOT.initialDoc || { title: "", toc: [], taskListCount: 0 },
    searchMatches: [],
    searchIndex: -1,
    treeData: null,
    sse: null,
    pendingScroll: 0,
  };

  // ---------- Element refs ----------
  const $ = (sel) => document.querySelector(sel);
  const articleEl = $("[data-article]");
  const titleEl = $("[data-title]");
  const tocEl = $("[data-toc]");
  const treeEl = $("[data-tree]");
  const searchInput = $("[data-search-input]");
  const searchCount = $("[data-search-count]");
  const exportBtn = $("[data-export]");
  const footerPath = $("[data-footer-path]");
  const footerModified = $("[data-footer-modified]");

  // ---------- Color swatches ----------

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
        if (m.index > from) frag.appendChild(document.createTextNode(text.slice(from, m.index)));
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

  // ---------- TOC active section ----------
  let tocObserver = null;
  function rebuildTocObserver() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    const headings = Array.from(articleEl.querySelectorAll("h2.kindmd-h2"));
    if (!headings.length) return;
    const seen = new Map(); // id → intersection ratio
    tocObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
      }
      let topId = null;
      let topY = Infinity;
      for (const h of headings) {
        const rect = h.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.4 && rect.top > -rect.height) {
          if (rect.top < topY) { topY = rect.top; topId = h.id; }
        }
      }
      if (!topId) {
        for (const h of headings) {
          const r = h.getBoundingClientRect();
          if (r.top <= 100) topId = h.id; else break;
        }
      }
      const links = tocEl ? tocEl.querySelectorAll("a[data-toc-target]") : [];
      links.forEach((a) => {
        const isActive = a.getAttribute("data-toc-target") === topId;
        if (isActive) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
    }, { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.5, 1] });
    headings.forEach((h) => tocObserver.observe(h));
  }

  // TOC click — smooth scroll (handled by CSS scroll-behavior + native anchor)
  if (tocEl) {
    tocEl.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-toc-target]");
      if (!a) return;
      e.preventDefault();
      const id = a.getAttribute("data-toc-target");
      const target = document.getElementById(id);
      if (!target) return;
      // Auto-expand collapsed section
      const section = target.closest(".kindmd-section");
      if (section && section.classList.contains("is-collapsed")) {
        toggleSection(section, false);
      }
      target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", "#" + id);
    });
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // ---------- Collapsible H2 sections ----------
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
    const sections = Array.from(articleEl.querySelectorAll(".kindmd-section"));
    const collapsed = {};
    for (const s of sections) {
      const id = s.getAttribute("data-section-id");
      if (id && s.classList.contains("is-collapsed")) collapsed[id] = true;
    }
    lsSet(sectionCollapseKey(state.currentPath), collapsed);
  }

  function restoreSectionCollapse() {
    const map = lsGet(sectionCollapseKey(state.currentPath), {});
    const sections = articleEl.querySelectorAll(".kindmd-section");
    sections.forEach((s) => {
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
    clearSearchHighlights();
    if (!query || query.length < 2) {
      if (searchCount) searchCount.textContent = "";
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
    if (!searchCount) return;
    if (state.searchMatches.length === 0) {
      const v = searchInput && searchInput.value.trim();
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
    state.searchMatches.forEach((m, i) => m.classList.toggle("is-current", i === idx));
    state.searchIndex = idx;
    const mark = state.searchMatches[idx];
    // Auto-expand collapsed section containing the match
    const section = mark.closest(".kindmd-section");
    if (section && section.classList.contains("is-collapsed")) {
      toggleSection(section, false);
    }
    mark.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    });
    updateSearchCount();
  }

  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(searchInput.value), 120);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!state.searchMatches.length) return;
        const next = e.shiftKey
          ? (state.searchIndex - 1 + state.searchMatches.length) % state.searchMatches.length
          : (state.searchIndex + 1) % state.searchMatches.length;
        focusMatch(next);
      } else if (e.key === "Escape") {
        searchInput.value = "";
        clearSearchHighlights();
        updateSearchCount();
        searchInput.blur();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (searchInput) { searchInput.focus(); searchInput.select(); }
    } else if (e.key === "Escape" && document.activeElement !== searchInput) {
      // No-op for now; reserved.
    }
  });

  // ---------- Export self-contained HTML ----------
  if (exportBtn) {
    exportBtn.addEventListener("click", () => exportSelfContained());
  }

  async function exportSelfContained() {
    let cssText = "";
    let jsText = "";
    // Try to fetch the bundled CSS / JS; if they were inlined already, use them.
    const inlineStyle = document.querySelector("style");
    if (inlineStyle) cssText = inlineStyle.textContent || "";
    if (!cssText) {
      try {
        const r = await fetch("/__kindmd__/styles.css");
        if (r.ok) cssText = await r.text();
      } catch { /* ignore */ }
    }
    const inlineScripts = Array.from(document.querySelectorAll("script:not([type='application/json']):not([src])"));
    if (inlineScripts.length) jsText = inlineScripts.map((s) => s.textContent || "").join("\n");
    if (!jsText) {
      try {
        const r = await fetch("/__kindmd__/runtime.js");
        if (r.ok) jsText = await r.text();
      } catch { /* ignore */ }
    }

    // Build a clone of the current document to snapshot.
    const clone = document.documentElement.cloneNode(true);
    // Remove existing style links and external script refs.
    clone.querySelectorAll('link[rel="stylesheet"], script[src]').forEach((n) => n.remove());
    // Replace any existing inline style/script with the bundled content (deduplicates).
    clone.querySelectorAll("style").forEach((n) => n.remove());
    clone.querySelectorAll('script:not([type="application/json"])').forEach((n) => n.remove());

    const head = clone.querySelector("head");
    if (head) {
      const styleNode = document.createElement("style");
      styleNode.textContent = cssText;
      head.appendChild(styleNode);
    }
    const body = clone.querySelector("body");
    if (body) {
      const scriptNode = document.createElement("script");
      scriptNode.textContent = jsText;
      body.appendChild(scriptNode);
    }

    const html = "<!doctype html>\n" + clone.outerHTML;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (state.currentDoc.title || "document").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "document";
    a.href = url;
    a.download = `${safe}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- In-pane link handling (folder mode) ----------
  function handleArticleClick(e) {
    const a = e.target.closest("a.kindmd-link-internal");
    if (!a) return;
    if (MODE !== "folder") return;
    const rawHref = a.getAttribute("data-kindmd-href") || a.getAttribute("href");
    if (!rawHref) return;
    // Anchor-only links: handled by default browser scroll.
    if (rawHref.startsWith("#")) return;
    // Resolve relative to currentPath
    const resolved = resolveDocPath(rawHref, state.currentPath);
    if (resolved && /\.md(#.*)?$/i.test(resolved)) {
      e.preventDefault();
      const [pathOnly, hash] = resolved.split("#");
      loadDoc(pathOnly, { push: true, hash });
    }
  }

  function resolveDocPath(href, basePath) {
    try {
      const base = new URL((basePath || "/").replace(/^\/+/, "/"), location.origin);
      const url = new URL(href, base);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/")) pathname = pathname.slice(1);
      const hash = url.hash ? url.hash : "";
      return pathname + hash;
    } catch { return null; }
  }

  if (articleEl) articleEl.addEventListener("click", handleArticleClick);

  // ---------- Folder mode bootstrapping ----------
  async function loadTree() {
    if (!treeEl) return;
    try {
      const r = await fetch("/api/tree");
      const tree = await r.json();
      state.treeData = tree;
      renderTree(tree);
    } catch (err) {
      treeEl.innerHTML = `<p class="kindmd-error">Failed to load files.</p>`;
    }
  }

  function renderTree(tree) {
    if (!treeEl) return;
    const collapsedMap = lsGet(treeCollapseKey(), {});
    const root = document.createElement("ul");
    root.className = "kindmd-tree-root";
    buildTreeNodes(tree, root, collapsedMap, "");
    treeEl.innerHTML = "";
    treeEl.appendChild(root);
    highlightActiveInTree();
  }

  function buildTreeNodes(items, parent, collapsedMap, parentPath) {
    if (!items || !items.length) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="kindmd-tree-row"><em>(empty)</em></span>`;
      parent.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement("li");
      if (item.type === "folder") {
        li.className = "kindmd-tree-folder";
        const folderPath = parentPath ? `${parentPath}/${item.name}` : item.name;
        if (collapsedMap[folderPath]) li.classList.add("is-collapsed");
        const row = document.createElement("span");
        row.className = "kindmd-tree-row";
        row.innerHTML = `<span class="kindmd-tree-chevron" aria-hidden="true">▾</span><span>${escapeHtml(item.name)}/</span>`;
        row.addEventListener("click", () => {
          li.classList.toggle("is-collapsed");
          const map = lsGet(treeCollapseKey(), {});
          if (li.classList.contains("is-collapsed")) map[folderPath] = true;
          else delete map[folderPath];
          lsSet(treeCollapseKey(), map);
        });
        li.appendChild(row);
        const ul = document.createElement("ul");
        buildTreeNodes(item.children, ul, collapsedMap, folderPath);
        li.appendChild(ul);
      } else {
        const a = document.createElement("a");
        a.className = "kindmd-tree-row kindmd-tree-file";
        a.href = "/" + item.path;
        a.setAttribute("data-tree-path", item.path);
        a.textContent = item.name;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          loadDoc(item.path, { push: true });
        });
        li.appendChild(a);
      }
      parent.appendChild(li);
    }
  }

  function highlightActiveInTree() {
    if (!treeEl) return;
    const links = treeEl.querySelectorAll("[data-tree-path]");
    links.forEach((l) => {
      l.classList.toggle("is-active", l.getAttribute("data-tree-path") === state.currentPath);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function loadDoc(path, options = {}) {
    const { push = false, hash = "", preserveScroll = false, preserveTasks = false } = options;
    const scrollY = preserveScroll ? window.scrollY : 0;
    try {
      const r = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
      if (!r.ok) {
        articleEl.innerHTML = `<div class="kindmd-empty"><p class="kindmd-error">Failed to load <code>${escapeHtml(path)}</code> (${r.status}).</p></div>`;
        return;
      }
      const doc = await r.json();
      state.currentPath = doc.path;
      state.currentDoc = doc;

      if (titleEl) titleEl.textContent = doc.title;
      document.title = doc.title;
      if (footerPath) footerPath.textContent = doc.path;
      if (footerModified) footerModified.textContent = doc.modifiedAt || "";

      articleEl.innerHTML = doc.html;
      injectColorSwatches(articleEl);
      rebuildToc(doc.toc);
      wireSectionToggles();
      restoreSectionCollapse();
      annotateBrokenLinks();
      rebuildTocObserver();
      highlightActiveInTree();
      if (push) {
        history.pushState({ path }, "", "/" + path + (hash ? "#" + hash : ""));
      }
      if (hash) {
        const target = document.getElementById(hash);
        if (target) target.scrollIntoView({ behavior: "auto", block: "start" });
      } else if (preserveScroll) {
        window.scrollTo(0, scrollY);
      } else {
        window.scrollTo(0, 0);
      }
    } catch (err) {
      articleEl.innerHTML = `<div class="kindmd-empty"><p class="kindmd-error">Failed to load <code>${escapeHtml(path)}</code>.</p></div>`;
    }
  }

  function rebuildToc(toc) {
    if (!tocEl) return;
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
      li.appendChild(a);
      ol.appendChild(li);
    }
    tocEl.innerHTML = "";
    tocEl.appendChild(ol);
  }

  function annotateBrokenLinks() {
    if (MODE !== "folder" || !state.treeData) return;
    const fileSet = new Set();
    collectFiles(state.treeData, fileSet);
    const links = articleEl.querySelectorAll("a.kindmd-link-internal");
    links.forEach((a) => {
      const raw = a.getAttribute("data-kindmd-href") || a.getAttribute("href");
      if (!raw || raw.startsWith("#")) return;
      const resolved = resolveDocPath(raw, state.currentPath);
      if (!resolved) return;
      const [pathOnly] = resolved.split("#");
      if (/\.md$/i.test(pathOnly) && !fileSet.has(pathOnly)) {
        a.classList.add("kindmd-broken");
        a.setAttribute("title", "File not found");
      }
    });
  }

  function collectFiles(items, set) {
    if (!items) return;
    for (const it of items) {
      if (it.type === "folder") collectFiles(it.children, set);
      else if (it.path) set.add(it.path);
    }
  }

  // ---------- Popstate (back/forward) ----------
  window.addEventListener("popstate", () => {
    if (MODE !== "folder") return;
    let path = decodeURIComponent(location.pathname).replace(/^\/+/, "");
    if (!path) path = state.currentPath; // Index — reload root
    loadDoc(path, { push: false, hash: location.hash.replace(/^#/, "") });
  });

  // ---------- SSE file watcher ----------
  function connectWatcher() {
    if (MODE !== "folder" || !("EventSource" in window)) return;
    try {
      state.sse = new EventSource("/api/watch");
      state.sse.addEventListener("change", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.path && data.path === state.currentPath) {
            loadDoc(state.currentPath, { push: false, preserveScroll: true });
          } else if (data.tree) {
            loadTree();
          }
        } catch { /* ignore */ }
      });
      state.sse.onerror = () => {
        if (state.sse) state.sse.close();
        state.sse = null;
        setTimeout(connectWatcher, 2000);
      };
    } catch { /* ignore */ }
  }

  // ---------- Boot ----------
  function boot() {
    injectColorSwatches(articleEl);
    wireSectionToggles();
    restoreSectionCollapse();
    rebuildTocObserver();
    if (MODE === "folder") {
      loadTree().then(() => {
        annotateBrokenLinks();
      });
      connectWatcher();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
