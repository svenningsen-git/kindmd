import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import attrs from "markdown-it-attrs";
import matter from "gray-matter";
import Prism from "prismjs";
import loadLanguages from "prismjs/components/index.js";

// Load common Prism languages up-front. Errors are swallowed because some
// names are aliases and re-loading is harmless.
const PRISM_LANGS = [
  "markup", "css", "clike", "javascript", "typescript", "jsx", "tsx",
  "json", "yaml", "bash", "shell", "python", "ruby", "go", "rust",
  "java", "kotlin", "swift", "c", "cpp", "csharp", "sql", "markdown",
  "diff", "ini", "toml", "docker", "graphql", "scss", "less",
];
try { loadLanguages(PRISM_LANGS); } catch { /* ignore */ }

const LANG_ALIASES = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
};

function highlight(code, lang) {
  const resolved = LANG_ALIASES[lang] || lang;
  if (resolved && Prism.languages[resolved]) {
    try {
      return Prism.highlight(code, Prism.languages[resolved], resolved);
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const NUMERIC_RE = /^\s*[+-]?(?:[$€£¥]|kr\.?|DKK|EUR|USD|GBP)?\s*[\d.,]+(?:\s*(?:%|kr\.?|DKK|EUR|USD|GBP))?\s*$/i;

function isNumericColumn(cells) {
  let hasAny = false;
  for (const cell of cells) {
    const trimmed = cell.trim();
    if (!trimmed) continue;
    hasAny = true;
    if (!NUMERIC_RE.test(trimmed)) return false;
    const cleaned = trimmed
      .replace(/[$€£¥%]/g, "")
      .replace(/kr\.?|DKK|EUR|USD|GBP/gi, "")
      .replace(/[\s,]/g, "")
      .trim();
    if (cleaned === "" || cleaned === "+" || cleaned === "-") return false;
    if (isNaN(Number(cleaned))) return false;
  }
  return hasAny;
}

function buildMarkdownIt() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    breaks: false,
    highlight: () => "", // we render code blocks ourselves via custom rule
  });

  md.use(anchor, {
    level: [2, 3],
    slugify,
    permalink: anchor.permalink.linkInsideHeader({
      symbol: "#",
      placement: "after",
      ariaHidden: true,
      class: "kindmd-anchor",
    }),
  });

  md.use(taskLists, { enabled: true, label: true, lineNumber: false });
  md.use(attrs);

  return md;
}

// Process AST tokens to:
// - Track which H1 is first (becomes masthead)
// - Re-tag subsequent H1s as H2s
// - Number H2 sections and prep TOC entries
// - Demote H5/H6 to bold paragraph
function transformHeadings(tokens) {
  const toc = [];
  let h1Seen = false;
  let h2Count = 0;
  let firstH1Text = null;

  // First pass: find first H1, demote later H1s, number H2s, capture TOC.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;
    const tag = t.tag;
    const inline = tokens[i + 1];
    const closeIdx = i + 2;
    const closeTok = tokens[closeIdx];

    if (tag === "h1") {
      if (!h1Seen) {
        h1Seen = true;
        firstH1Text = inline.content;
        // Mark for removal — the title is rendered via the masthead.
        t.meta = { ...(t.meta || {}), kindmdDrop: true };
        inline.meta = { ...(inline.meta || {}), kindmdDrop: true };
        if (closeTok) closeTok.meta = { ...(closeTok.meta || {}), kindmdDrop: true };
      } else {
        // Demote subsequent H1 → H2
        t.tag = "h2";
        if (closeTok) closeTok.tag = "h2";
      }
    }

    if (t.tag === "h2") {
      h2Count++;
      const num = String(h2Count).padStart(2, "0");
      const id = slugify(inline.content) || `section-${h2Count}`;
      // Force this id so the TOC + scrollspy align with the heading.
      t.attrJoin("class", "kindmd-h2");
      t.attrSet("id", id);
      t.meta = { ...(t.meta || {}), kindmdSectionNumber: num, kindmdId: id };
      inline.meta = { ...(inline.meta || {}), kindmdSectionNumber: num };
      toc.push({ id, text: inline.content, num });
    }

    if (t.tag === "h3") {
      t.attrJoin("class", "kindmd-h3");
    }

    if (t.tag === "h4") {
      t.attrJoin("class", "kindmd-h4");
    }

    if (t.tag === "h5" || t.tag === "h6") {
      // Demote to bold paragraph
      t.tag = "p";
      if (closeTok) closeTok.tag = "p";
      t.attrJoin("class", "kindmd-h-demoted");
    }
  }

  return toc;
}

function countTaskListItems(tokens) {
  // markdown-it-task-lists emits `<input type="checkbox">` as html_inline
  // tokens inside each task list item's inline children. Count those.
  let count = 0;
  for (const t of tokens) {
    if (t.type !== "inline" || !t.children) continue;
    for (const c of t.children) {
      if (c.type === "html_inline" && /<input[^>]*type="checkbox"/.test(c.content)) {
        count++;
      }
    }
  }
  return count;
}

function transformTables(tokens) {
  // Walk top-level tokens. For each table_open … table_close pair,
  // collect header cells + body cell content, auto-detect numeric columns,
  // apply alignment classes, and wrap the table in a scroll container.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "table_open") continue;
    const startIdx = i;
    let endIdx = i;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === "table_close") {
        endIdx = j;
        break;
      }
    }

    // Collect cells per column.
    const headerCells = [];
    const bodyColumns = []; // array of arrays
    let inHead = false;
    let inBody = false;
    let inRow = false;
    let currentRow = [];
    let cellTokens = null;

    for (let j = startIdx; j <= endIdx; j++) {
      const t = tokens[j];
      if (t.type === "thead_open") inHead = true;
      else if (t.type === "thead_close") inHead = false;
      else if (t.type === "tbody_open") inBody = true;
      else if (t.type === "tbody_close") inBody = false;
      else if (t.type === "tr_open") { inRow = true; currentRow = []; }
      else if (t.type === "tr_close") {
        inRow = false;
        if (inBody) {
          for (let c = 0; c < currentRow.length; c++) {
            if (!bodyColumns[c]) bodyColumns[c] = [];
            bodyColumns[c].push(currentRow[c]);
          }
        }
      } else if (t.type === "th_open" || t.type === "td_open") {
        cellTokens = { open: t, contentInline: null };
      } else if (t.type === "inline" && cellTokens) {
        cellTokens.contentInline = t;
      } else if (t.type === "th_close" || t.type === "td_close") {
        if (cellTokens && inHead) headerCells.push(cellTokens);
        else if (cellTokens && inBody) currentRow.push(cellTokens);
        cellTokens = null;
      }
    }

    // Detect numeric per column unless GFM align is explicit.
    const colCount = headerCells.length;
    for (let c = 0; c < colCount; c++) {
      const explicit = headerCells[c]?.open.attrGet("style") || "";
      let alignment = null;
      if (/text-align:right/.test(explicit)) alignment = "right";
      else if (/text-align:center/.test(explicit)) alignment = "center";
      else if (/text-align:left/.test(explicit)) alignment = "left";

      if (!alignment) {
        const cellStrings = (bodyColumns[c] || []).map(
          (tk) => tk.contentInline?.content || ""
        );
        if (isNumericColumn(cellStrings)) alignment = "right";
      }

      if (alignment === "right") {
        headerCells[c]?.open.attrJoin("class", "kindmd-num");
        for (const tk of bodyColumns[c] || []) {
          tk.open.attrJoin("class", "kindmd-num");
        }
      } else if (alignment === "center") {
        headerCells[c]?.open.attrJoin("class", "kindmd-center");
        for (const tk of bodyColumns[c] || []) {
          tk.open.attrJoin("class", "kindmd-center");
        }
      }
    }

    // Look for an italic-only caption paragraph immediately before the table.
    // markdown-it tokens: paragraph_open, inline (with one em child), paragraph_close.
    let captionInline = null;
    if (startIdx >= 3) {
      const pClose = tokens[startIdx - 1];
      const pInline = tokens[startIdx - 2];
      const pOpen = tokens[startIdx - 3];
      if (pOpen?.type === "paragraph_open" &&
          pInline?.type === "inline" &&
          pClose?.type === "paragraph_close" &&
          pInline.children && pInline.children.length === 3 &&
          pInline.children[0].type === "em_open" &&
          pInline.children[1].type === "text" &&
          pInline.children[2].type === "em_close") {
        captionInline = pInline.children[1].content;
        // Mark the three caption tokens as dropped — we'll re-emit them
        // as a table caption.
        pOpen.meta = { ...(pOpen.meta || {}), kindmdDrop: true };
        pInline.meta = { ...(pInline.meta || {}), kindmdDrop: true };
        pClose.meta = { ...(pClose.meta || {}), kindmdDrop: true };
      }
    }

    // Wrap table in scroll container by overriding renders below.
    tokens[startIdx].meta = {
      ...(tokens[startIdx].meta || {}),
      kindmdWrap: true,
      kindmdCaption: captionInline,
    };
    tokens[endIdx].meta = {
      ...(tokens[endIdx].meta || {}),
      kindmdWrap: true,
    };

    i = endIdx;
  }
}

function installCustomRenderers(md) {
  // (Drop tokens are pruned from the array before rendering — see pruneDropped.)

  // H2 — wrap with section markers, chevron toggle, anchor link.
  const origHeadingOpen = md.renderer.rules.heading_open;
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.tag === "h2" && t.meta?.kindmdSectionNumber) {
      const num = t.meta.kindmdSectionNumber;
      const id = t.attrGet("id") || "";
      const inline = tokens[idx + 1];
      const text = inline?.content || "";
      env.h2OpenContext = { id, num, text };
      return `<section class="kindmd-section" data-section-id="${escapeHtml(id)}">\n` +
        `<header class="kindmd-section-header">\n` +
        `<h2 id="${escapeHtml(id)}" class="kindmd-h2">`;
    }
    if (origHeadingOpen) return origHeadingOpen(tokens, idx, options, env, self);
    return self.renderToken(tokens, idx, options);
  };

  const origHeadingClose = md.renderer.rules.heading_close;
  md.renderer.rules.heading_close = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (t.tag === "h2" && env.h2OpenContext) {
      const ctx = env.h2OpenContext;
      env.h2OpenContext = null;
      env.openSectionId = ctx.id;
      return `</h2>\n` +
        `<button class="kindmd-section-toggle" type="button" aria-expanded="true" aria-controls="${escapeHtml(ctx.id)}-body">` +
        `<span class="kindmd-section-chevron" aria-hidden="true">▾</span>` +
        `<span class="kindmd-section-label" data-label-expanded="Collapse" data-label-collapsed="Expand">Collapse</span>` +
        `</button>\n` +
        `</header>\n<div class="kindmd-section-body" id="${escapeHtml(ctx.id)}-body">\n`;
    }
    if (origHeadingClose) return origHeadingClose(tokens, idx, options, env, self);
    return self.renderToken(tokens, idx, options);
  };

  // Need to emit </div></section> at the next H2 or end of doc.
  // We do that by post-processing the rendered HTML rather than tracking
  // close points across tokens — the marker `<section class="kindmd-section"`
  // tells us where the previous section ends.

  // Fenced code block — dark surface with language label.
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info || "").trim().split(/\s+/)[0] || "";
    const label = lang || "code";
    const highlighted = lang
      ? highlight(t.content, lang)
      : escapeHtml(t.content);
    return `<figure class="kindmd-code">\n` +
      `  <figcaption class="kindmd-code-label">${escapeHtml(label)}</figcaption>\n` +
      `  <pre class="kindmd-code-pre"><code class="language-${escapeHtml(lang || "plaintext")}">${highlighted}</code></pre>\n` +
      `</figure>\n`;
  };

  // Inline code → mono chip.
  const origCodeInline = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const html = origCodeInline
      ? origCodeInline(tokens, idx, options, env, self)
      : `<code>${escapeHtml(tokens[idx].content)}</code>`;
    return html.replace("<code>", '<code class="kindmd-code-inline">');
  };

  // Table — wrap with scroll container + optional caption.
  const origTableOpen = md.renderer.rules.table_open;
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    let out = `<div class="kindmd-table-wrap">\n`;
    if (t.meta?.kindmdCaption) {
      out += `<p class="kindmd-table-caption"><em>${escapeHtml(t.meta.kindmdCaption)}</em></p>\n`;
    }
    out += origTableOpen
      ? origTableOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
    return out;
  };
  const origTableClose = md.renderer.rules.table_close;
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
    const base = origTableClose
      ? origTableClose(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
    return base + `</div>\n`;
  };

  // Images → centred figure with caption.
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet("src") || "";
    const alt = t.content || "";
    const title = t.attrGet("title") || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    let html = `<figure class="kindmd-figure">\n` +
      `  <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy"${titleAttr}>\n`;
    if (alt) {
      html += `  <figcaption class="kindmd-figure-caption"><em>${escapeHtml(alt)}</em></figcaption>\n`;
    }
    html += `</figure>`;
    return html;
  };

  // Links — external get noopener + new tab; non-http get class for downstream
  // handling (in-pane navigation, broken markers).
  const origLinkOpen = md.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    const href = t.attrGet("href") || "";
    const cls = t.attrGet("class") || "";
    // Skip styling on the markdown-it-anchor permalink — it has its own muted look.
    if (cls.includes("kindmd-anchor")) {
      return origLinkOpen(tokens, idx, options, env, self);
    }
    if (/^https?:\/\//i.test(href)) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
      t.attrJoin("class", "kindmd-link kindmd-link-external");
    } else if (href.startsWith("#")) {
      t.attrJoin("class", "kindmd-link kindmd-link-anchor");
    } else {
      t.attrJoin("class", "kindmd-link kindmd-link-internal");
      t.attrSet("data-kindmd-href", href);
    }
    return origLinkOpen(tokens, idx, options, env, self);
  };

  // Thematic break → editorial mark.
  md.renderer.rules.hr = () =>
    `<hr class="kindmd-hr" aria-hidden="true">\n`;

  // Blockquote → editorial pull-quote class hook.
  const origBQOpen = md.renderer.rules.blockquote_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
    tokens[idx].attrJoin("class", "kindmd-blockquote");
    return origBQOpen(tokens, idx, options, env, self);
  };
}

function postProcessSections(html) {
  // Insert closing `</div></section>` before each subsequent kindmd-section
  // opener and at end of document. Cleaner implementation than split-and-join.
  const lines = html.split("\n");
  const out = [];
  let depth = 0;
  for (const line of lines) {
    if (line.startsWith('<section class="kindmd-section"')) {
      if (depth > 0) {
        out.push("</div>", "</section>");
        depth--;
      }
      out.push(line);
      depth++;
    } else {
      out.push(line);
    }
  }
  while (depth > 0) {
    out.push("</div>", "</section>");
    depth--;
  }
  return out.join("\n");
}

const SHARED_MD = buildMarkdownIt();
installCustomRenderers(SHARED_MD);

function pruneDropped(tokens) {
  return tokens.filter((t) => !t.meta?.kindmdDrop);
}

export function render(input, options = {}) {
  const { content, data: frontmatter } = matter(input || "");
  const md = SHARED_MD;

  // Tokenise so we can pre-process before rendering.
  const env = {};
  const tokens = md.parse(content, env);

  const toc = transformHeadings(tokens);
  transformTables(tokens);
  const taskListCount = countTaskListItems(tokens);

  const pruned = pruneDropped(tokens);
  let html = md.renderer.render(pruned, md.options, env);
  html = postProcessSections(html);

  const title =
    (typeof frontmatter.title === "string" && frontmatter.title.trim()) ||
    (toc.length === 0 && extractFirstH1(content)) ||
    extractFirstH1(content) ||
    options.fallbackTitle ||
    "Untitled";

  const language =
    (typeof frontmatter.lang === "string" && frontmatter.lang.trim()) ||
    options.lang ||
    "en";

  return {
    title,
    html,
    toc: toc.map(({ id, text, num }) => ({ id, text, num })),
    taskListCount,
    language,
    frontmatter,
  };
}

function extractFirstH1(content) {
  const lines = content.split("\n");
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}
