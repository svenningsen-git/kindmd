# Changelog

## 2.0.0

### Added — HTML mode & Marginalia
- Open `.html` / `.htm` files: the document renders like a browser inside a centred page card, with a comment gutter alongside — built for reviewing AI-generated HTML.
- Rendered in a same-origin sandboxed iframe; the page's CSS renders fully while its scripts stay inert (a reader/annotator, not a runner) — a deliberate safety choice given the app's privileged bridge.
- **Read / Edit** toggle (`⌘E`): in Edit mode, click any text block to edit it in place. Text-only guard rails — rich-format shortcuts blocked, paste de-formatted, `Enter` commits.
- **Margin comments**: select text → floating **💬 Comment** button → a highlight lands in the document and a note card pins beside it in the gutter. Resolve / reopen / delete per card; cards de-overlap automatically.
- **Annotations save into the file**: highlight spans (`[data-comment-id]`) plus an appended `<section id="__doc-comments">` — comments travel with the document and rehydrate on reopen. `⌘S` / **Save** writes straight to disk.
- **Show / hide comments** collapses the gutter for full-width reading.
- Adapted from the "Marginalia" Claude Design prototype; save-to-disk replaces the prototype's browser download, and the app's file tree replaces its single-file open.

### Changed — fully monochrome
- Entire palette converted to neutral greyscale. The oxblood/gold/sage accents, warm paper/ink/rule tones, and CSV filter tints are all monochrome. Code-block **syntax highlighting keeps its colours** — the one deliberate exception, since colour carries meaning there.
- Sidebar (file navigation) is white with black text and a black active row.
- CSV renders on a white surface; HTML sits on a soft neutral stage so the document card reads as a page; the markdown reader is neutral paper.

### Changed — unified Read/Edit control
- Markdown now uses the same segmented **Read / Edit** control as HTML (shared styling); Export / Save-as and the HTML tools share one monochrome button language. CSV stays view-only.

### Added — find-in-document search for HTML
- The search box now works in HTML mode too: matches are highlighted inside the document, `Enter` / `Shift-Enter` step through them, `Esc` clears. Search marks never touch the saved file.

### Added — portable, self-contained comments
- Saving an annotated HTML file now embeds a small self-contained marginalia component (inline CSS + JS) alongside the highlight spans and comment data. **Open the saved file in any regular browser and the comment gutter renders with a Show/Hide toggle and pins aligned to each highlight** — no kindmd required. kindmd strips the embedded component on open and re-emits it on save, so editing round-trips cleanly.

### Changed — browser-like HTML rendering
- The HTML document now renders edge-to-edge like a browser tab — no card framing, borders, or outer padding — filling the whole content area, with the comments as a side panel on the right (edge-to-edge when comments are hidden). Previously it sat in a narrow, padded, centered card.

## Unreleased

### Added — CSV / TSV reader mode
- Open `.csv` and `.tsv` files directly — kindmd registers as the default macOS handler for both via `LSSetDefaultRoleHandlerForContentType`.
- Excel-style grid: column letters (`A`, `B`, `C` …) above the headers, sticky frozen header row, sticky bold first column, row-number gutter.
- Per-column sort (asc / desc / none cycle), per-column filter with searchable value list and counts.
- Filtered columns are visually distinct across the letter strip, header (oxblood underline + tint), filter pill, and body cells.
- **Columns ▾** toolbar dropdown to show / hide any column (right TOC pane is hidden in CSV mode — table runs to the window edge).
- Global search box doubles as a row filter across visible columns.
- **Copy table** as TSV — paste straight into a spreadsheet. Also available on every markdown table (hover-revealed pill).

### Added — Edit mode
- Toggle markdown source ↔ rendered article via the Edit pill in the masthead or `⌘E`. `⌘S` saves; `Esc` exits.
- TOC and search both work in edit mode — TOC scroll-spy tracks the textarea, search highlights live ranges in the source.
- **Save As…** replaces Export in the masthead while editing.

### Added — Editorial polish
- Inline color swatches for `#hex`, `rgb()`, `hsl()`, `oklch()`, `lab()`, etc.
- Double-click a file in the sidebar to rename inline (extension preserved).
- Right-click a folder in the sidebar → **Open in Claude Code** (launches Terminal at the folder and runs `claude`).
- Sidebar uses solid `#F2EEE5` paper instead of OS vibrancy for a consistent palette.

### Changed
- Native Mac app via Electron: `npm run app` opens a window with Finder-style file browser, native menu bar (`⌘O`, `⌘F`, `⌘\`, `⌘⇧T`, `⌘R`), file watcher with scroll preservation.
- Packaged + installable via `npm run dist` + `npm run install-app` — copies to `/Applications`, ad-hoc signs, registers as default handler for `.md`, `.markdown`, `.mdown`, `.mkd`, `.csv`, `.tsv`.
- First H1 is dropped from the body (rendered in the masthead instead).
- Auto-open folder picker on cold launch (no `.md` argument).

### Removed
- Task-list checkbox interactivity + progress ring (markdown doesn't store check state; rendering it as toggle-able was misleading). Task lists now render as plain bullets.

## v1.0.0

Initial release.

- CLI: `kindmd [path]` — file mode (temp HTML + browser open) or folder mode (three-pane reader with local server)
- Editorial render rules — fixed deterministic mapping from CommonMark + GFM task lists / tables to HTML/CSS, no theming
- Three-pane folder reader: file tree (left), rendered content (middle), TOC (right)
- Interactive features: TOC active-section tracking, search (⌘K) with highlighting + Enter/Shift-Enter navigation, native task list checkboxes persisted to localStorage, masthead progress ring, collapsible H2 sections with labelled `Collapse` / `Expand` control, in-pane cross-doc navigation, browser back/forward via History API, file watcher via SSE
- Export: self-contained HTML (CSS + JS inlined, no external requests)
- Accessibility: skip link, semantic landmarks, visible focus rings, `prefers-reduced-motion` honoured, ARIA on tree + TOC + search, state never conveyed by colour alone
- Library API: `render(markdown, opts) → { title, html, toc, taskListCount, language }`
