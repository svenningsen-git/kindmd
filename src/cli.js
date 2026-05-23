import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import open from "open";

import { render } from "./render.js";
import { renderPage } from "./template.js";
import { startFolderServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

export async function run(argv) {
  const program = new Command();
  program
    .name("kindmd")
    .description("An editorial markdown reader.")
    .version(pkg.version, "-v, --version", "Print the version")
    .argument("[path]", "File or folder to read")
    .option("--port <port>", "Override auto-picked port (folder mode)", (v) => parseInt(v, 10))
    .option("--all", "Include hidden files in tree")
    .option("--no-open", "Do not auto-open browser")
    .helpOption("-h, --help", "Print this help")
    .exitOverride((err) => {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") process.exit(0);
      const e = new Error(err.message || "Invalid arguments");
      e.exitCode = 2;
      throw e;
    })
    .parse(argv);

  const opts = program.opts();
  const target = program.args[0] || ".";

  const absTarget = path.resolve(process.cwd(), target);

  let stat;
  try {
    stat = fs.statSync(absTarget);
  } catch {
    const e = new Error(`file not found: ${target}`);
    e.exitCode = 1;
    throw e;
  }

  if (stat.isFile()) {
    await runFileMode(absTarget, opts);
  } else if (stat.isDirectory()) {
    await runFolderMode(absTarget, opts);
  } else {
    const e = new Error(`unreadable: ${target}`);
    e.exitCode = 1;
    throw e;
  }
}

async function runFileMode(absFile, opts) {
  let raw;
  try { raw = fs.readFileSync(absFile, "utf8"); }
  catch (err) {
    const e = new Error(`unreadable: ${absFile}`);
    e.exitCode = 1;
    throw e;
  }
  const doc = render(raw, { fallbackTitle: path.basename(absFile, ".md") });
  const stat = fs.statSync(absFile);
  const html = renderPage({
    doc,
    docPath: absFile,
    modifiedAt: stat.mtime.toISOString(),
    mode: "file",
    inline: true,
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "kindmd-"));
  const outFile = path.join(outDir, `${path.basename(absFile, ".md")}.html`);
  fs.writeFileSync(outFile, html, "utf8");

  process.stdout.write(`kindmd: rendered ${path.basename(absFile)} → ${outFile}\n`);

  if (opts.open !== false) {
    await open(outFile);
  }
}

async function runFolderMode(absFolder, opts) {
  const { server, port, close } = await startFolderServer(absFolder, {
    port: opts.port,
    includeHidden: !!opts.all,
  });

  const url = `http://localhost:${port}`;
  process.stdout.write(`kindmd: serving ${absFolder}\n`);
  process.stdout.write(`kindmd: ${url}\n`);

  const shutdown = async () => {
    process.stdout.write("\nkindmd: shutting down…\n");
    try { await close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (opts.open !== false) {
    try { await open(url); } catch { /* ignore */ }
  }
}
