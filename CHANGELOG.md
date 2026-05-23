# Changelog

## Unreleased

- Native Mac app via Electron: `npm run app` opens a window with translucent vibrancy sidebar, Finder-style file browser (lazy-loaded full filesystem, folders + all files), native menu bar (`⌘O`, `⌘F`, `⌘\`, `⌘⇧T`, `⌘R`), and file watcher with scroll/task preservation.

## v1.0.0

Initial release.

- CLI: `kindmd [path]` — file mode (temp HTML + browser open) or folder mode (three-pane reader with local server)
- Editorial render rules — fixed deterministic mapping from CommonMark + GFM task lists / tables to HTML/CSS, no theming
- Three-pane folder reader: file tree (left), rendered content (middle), TOC (right)
- Interactive features: TOC active-section tracking, search (⌘K) with highlighting + Enter/Shift-Enter navigation, native task list checkboxes persisted to localStorage, masthead progress ring, collapsible H2 sections with labelled `Collapse` / `Expand` control, in-pane cross-doc navigation, browser back/forward via History API, file watcher via SSE
- Export: self-contained HTML (CSS + JS inlined, no external requests)
- Accessibility: skip link, semantic landmarks, visible focus rings, `prefers-reduced-motion` honoured, ARIA on tree + TOC + search, state never conveyed by colour alone
- Library API: `render(markdown, opts) → { title, html, toc, taskListCount, language }`
