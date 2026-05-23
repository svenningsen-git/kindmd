import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXCLUDE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".DS_Store",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
]);

export function buildTree(rootDir, opts = {}) {
  const { includeHidden = false } = opts;
  const result = walk(rootDir, rootDir, includeHidden);
  return sortItems(result);
}

function walk(absDir, rootDir, includeHidden) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!includeHidden && name.startsWith(".")) continue;
    if (DEFAULT_EXCLUDE.has(name)) continue;
    const abs = path.join(absDir, name);
    if (entry.isDirectory()) {
      const children = walk(abs, rootDir, includeHidden);
      if (children.length === 0) continue;
      out.push({ type: "folder", name, children: sortItems(children) });
    } else if (entry.isFile() && name.toLowerCase().endsWith(".md")) {
      const rel = path.relative(rootDir, abs).split(path.sep).join("/");
      out.push({ type: "file", name, path: rel });
    }
  }
  return out;
}

function sortItems(items) {
  const folders = items.filter((i) => i.type === "folder")
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const files = items.filter((i) => i.type === "file");
  files.sort((a, b) => {
    const aIsReadme = a.name.toLowerCase() === "readme.md";
    const bIsReadme = b.name.toLowerCase() === "readme.md";
    if (aIsReadme && !bIsReadme) return -1;
    if (!aIsReadme && bIsReadme) return 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
  return [...folders, ...files];
}

export function defaultInitialFile(tree) {
  // Find first README.md at top level, else first file (depth-first).
  for (const item of tree) {
    if (item.type === "file" && item.name.toLowerCase() === "readme.md") {
      return item.path;
    }
  }
  return firstFile(tree);
}

function firstFile(tree) {
  for (const item of tree) {
    if (item.type === "file") return item.path;
    if (item.type === "folder") {
      const child = firstFile(item.children);
      if (child) return child;
    }
  }
  return null;
}
