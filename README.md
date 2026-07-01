# kindmd

> An editorial reader & editor for macOS. Markdown becomes a thoughtfully designed editorial page; CSV becomes a sortable, filterable spreadsheet; and HTML reads like a browser with in-place editing and margin comments (**Marginalia**) that save straight back into the file.

## Install as a Mac app

```bash
npm install
npm run dist          # build the .app bundle
npm run install-app   # copy to /Applications, sign, register as default handler
```

`install-app` registers kindmd as the default opener for `.md`, `.markdown`, `.mdown`, `.mkd`, `.csv`, and `.tsv`, and as an alternate opener for `.html` / `.htm` (so your browser stays the default — use **Open With → kindmd** or drag the file onto the app). Double-click a registered file in Finder and it opens here.

For day-to-day dev (no install required):

```bash
npm run app
```

### Markdown mode

- Three-pane reader: Finder-style sidebar · article · table of contents
- **Edit mode** (`⌘E` or the Edit pill) — markdown source with the same paper palette
- Inline color swatches for `#hex`, `rgb()`, `hsl()`, `oklch()`, etc.
- Numbered, collapsible H2 sections with a labelled `Collapse` / `Expand` control
- File watcher refreshes the article on disk save (preserves scroll)
- Double-click a file in the sidebar to rename it inline
- Right-click a folder → **Open in Claude Code** (launches Terminal + `claude`)

### CSV / TSV mode

- Excel-like grid with Excel column letters above the headers (`A`, `B`, `C`, …)
- Sticky frozen first row (header) and bold sticky first column
- Per-column **sort** (toggle asc / desc / none) and **filter** (checkbox list with search, counts, Select all / Clear)
- Filtered columns are visually distinct across letter row, header, and body cells
- **Copy table** (TSV) — also available on markdown tables
- **Columns ▾** dropdown in the toolbar — show / hide any column
- The global search box acts as a row filter across visible columns

### HTML mode — Marginalia

Open an `.html` / `.htm` file and it renders like a browser inside a document card, with a comment gutter alongside — great for reviewing AI-generated HTML output.

- **Read / Edit** toggle in the toolbar (or `⌘E`)
- **Edit in place** — in Edit mode, click any text block to edit it directly. Plain text only: rich-formatting shortcuts are blocked, paste is de-formatted, and `Enter` commits.
- **Margin comments** — select any text and click the floating **💬 Comment** button. A highlight is dropped in the document and a note card appears in the gutter, pinned next to the selection. Resolve, reopen, or delete from the card.
- **Saved into the file itself** — comments persist as `[data-comment-id]` highlight spans plus a `<section id="__doc-comments">` appended to the document, so annotations travel with the file and rehydrate when you reopen it. `⌘S` (or the **Save** button) writes straight back to disk.
- **Show / hide comments** collapses the gutter to read the document full-width.
- **Find in document** — `⌘F` searches inside the HTML; matches are highlighted, `Enter` / `Shift-Enter` step through them, `Esc` clears. Search marks never touch the saved file.
- The page's own scripts are **not executed** (the document is rendered for reading and annotating, not running); its CSS renders fully.

### Keyboard shortcuts

- `⌘O` — Open Folder…
- `⌘⇧O` — Open File…
- `⌘F` / `⌘K` — Focus search (markdown & HTML: highlight matches · CSV: filter rows)
- `⌘E` — Toggle edit mode (markdown source · HTML in-place)
- `⌘S` — Save (markdown edit mode · HTML any time)
- `⌘\` — Toggle sidebar
- `⌘⇧T` — Toggle TOC pane
- `⌘R` — Reveal current file in Finder
- `Esc` — Close popovers / exit edit mode / clear search

## Run as a CLI / browser reader

```bash
npm install -g kindmd

kindmd path/to/file.md          # render file, open in browser
kindmd path/to/folder/          # browse folder in three-pane reader
kindmd --port 8500 folder/      # override auto-picked port
kindmd --all folder/            # include hidden files
kindmd --no-open file.md        # don't auto-open browser
kindmd --version                # print version
kindmd --help                   # print usage
```

## What you get

- A restrained monochrome palette — neutral greyscale, no hue
- Numbered H2 sections with rule separators
- Auto-built TOC with active-section tracking (works in edit mode too)
- Live search with grey highlighting (markdown & HTML) or row filtering (CSV)
- GFM task lists rendered as bullets (kindmd never modifies the source)
- Inline color swatches next to recognised color literals
- Collapsible H2 sections
- Excel-like CSV viewer (sort, filter, freeze, copy-as-TSV)
- Self-contained HTML export
- WCAG 2.1 AA accessible
- Zero external network requests
- Zero configuration
- Zero AI

## Library

The renderer is a pure function — string in, structured doc out — and is the
long-lived asset behind the CLI.

```js
import { render } from "kindmd/render";

const doc = render(markdown, { lang: "en" });
// → { title, html, toc, taskListCount, language, frontmatter }
```

The full surface (renderer, page template, folder server, tree builder) is
also exported from the package root:

```js
import { render, renderPage, startFolderServer, buildTree } from "kindmd";
```

## What kindmd does NOT do

- No AI / LLM calls in the render pipeline.
- No web fonts. System stack only.
- No config file or theme system in v1.
- No telemetry, no phone-home.
- No modification of the source markdown.

## Development

```bash
npm install
npm test            # smoke tests
npm start -- ../path/to/folder
```

## License

MIT.
