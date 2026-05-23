#!/usr/bin/env node
/* Smoke tests for kindmd — no test framework, just throws on first failure. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../src/render.js";
import { buildTree, defaultInitialFile } from "../src/tree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "fixtures");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

// --- Render ---

test("render: basic markdown", () => {
  const out = render("# Title\n\n## Section\n\nBody.");
  assert.equal(out.title, "Title");
  assert.equal(out.toc.length, 1);
  assert.ok(out.html.includes("kindmd-section"));
  assert.ok(!out.html.includes(">Title<")); // H1 dropped from body
});

test("render: frontmatter title overrides H1", () => {
  const out = render("---\ntitle: Override\nlang: da\n---\n\n# Ignored\n");
  assert.equal(out.title, "Override");
  assert.equal(out.language, "da");
});

test("render: bogus frontmatter ignored", () => {
  const out = render("---\nfoo: bar\nbaz: qux\n---\n\n# Real\n");
  assert.ok(!out.html.includes("foo"));
  assert.ok(!out.html.includes("bar"));
});

test("render: H2 numbered, balanced sections", () => {
  const out = render("# T\n\n## One\n\nx\n\n## Two\n\ny\n");
  const open = (out.html.match(/<section class="kindmd-section"/g) || []).length;
  const close = (out.html.match(/<\/section>/g) || []).length;
  assert.equal(open, 2);
  assert.equal(close, 2);
  assert.equal(out.toc[0].num, "01");
  assert.equal(out.toc[1].num, "02");
});

test("render: task list count", () => {
  const out = render("# T\n\n## S\n\n- [ ] one\n- [x] two\n- [ ] three\n");
  assert.equal(out.taskListCount, 3);
  assert.ok(out.html.includes("contains-task-list"));
});

test("render: numeric column auto-right-aligned", () => {
  const out = render("# T\n\n## S\n\n| Region | Q1 |\n|---|---|\n| DK | 12.3 |\n| DE | 8.7 |\n");
  assert.ok(/class="kindmd-num"/.test(out.html));
});

test("render: italic-only paragraph before table becomes caption", () => {
  const out = render("# T\n\n## S\n\n*Quarterly figures.*\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.ok(out.html.includes("kindmd-table-caption"));
  assert.ok(!/<p>\s*<em>Quarterly figures\./.test(out.html));
});

test("render: external link gets noopener", () => {
  const out = render("# T\n\n[ext](https://example.com)\n");
  assert.ok(/rel="noopener noreferrer"/.test(out.html));
  assert.ok(/target="_blank"/.test(out.html));
});

test("render: H5/H6 demoted to bold paragraph", () => {
  const out = render("# T\n\n##### H5 demoted\n\n###### H6 demoted\n");
  assert.ok(out.html.includes("kindmd-h-demoted"));
  assert.ok(!/<h5/.test(out.html));
  assert.ok(!/<h6/.test(out.html));
});

test("render: anchor # placed after heading text", () => {
  const out = render("# T\n\n## Section A\n");
  // <h2 ...>Section A <a class="kindmd-anchor"...>#</a></h2>
  assert.ok(/<h2[^>]*>Section A\s*<a class="kindmd-anchor"/.test(out.html));
});

test("render: thematic break renders decorative", () => {
  const out = render("# T\n\n---\n");
  assert.ok(out.html.includes('class="kindmd-hr"'));
});

// --- Tree ---

test("tree: builds and sorts (README first within folder)", () => {
  if (!fs.existsSync(fixtures)) fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, "tree-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "# a");
    fs.writeFileSync(path.join(dir, "README.md"), "# Readme");
    fs.writeFileSync(path.join(dir, "z.md"), "# z");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "c.md"), "# c");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "no");
    const tree = buildTree(dir);
    const names = tree.map(t => t.name);
    assert.deepEqual(names, ["sub", "README.md", "a.md", "z.md"]);
    assert.equal(defaultInitialFile(tree), "README.md");
    assert.equal(tree.find(t => t.name === "sub").children[0].path, "sub/c.md");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("tree: hidden files excluded by default", () => {
  if (!fs.existsSync(fixtures)) fs.mkdirSync(fixtures, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fixtures, "tree-"));
  try {
    fs.writeFileSync(path.join(dir, "visible.md"), "# x");
    fs.writeFileSync(path.join(dir, ".hidden.md"), "# x");
    const tree = buildTree(dir);
    assert.deepEqual(tree.map(t => t.name), ["visible.md"]);
    const treeAll = buildTree(dir, { includeHidden: true });
    assert.ok(treeAll.some(t => t.name === ".hidden.md"));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
