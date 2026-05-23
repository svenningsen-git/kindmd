# kindmd

> An editorial markdown reader. Any markdown file becomes a thoughtfully designed editorial page via a fixed set of deterministic rules.

## Run as a native Mac app

```bash
npm install
npm run app
```

Opens a native window with a Finder-style sidebar (folders + files), a translucent vibrancy panel, and a native menu bar. Click any `.md` file in the sidebar to render it. Non-markdown files are listed for context but disabled.

- `⌘O` — Open Folder…
- `⌘⇧O` — Open File…
- `⌘F` — Find in document
- `⌘\` — Toggle sidebar
- `⌘⇧T` — Toggle TOC pane
- `⌘R` — Reveal current file in Finder
- File watcher updates the document on save, preserving scroll & task state.

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

- Warm cream paper, oxblood accents, mono eyebrows
- Numbered H2 sections with rule separators
- Auto-built TOC with active-section tracking
- Live search (⌘K) with gold highlighting
- Native checkbox task lists with persistence
- Progress ring tracking task completion
- Collapsible H2 sections
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
