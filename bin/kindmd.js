#!/usr/bin/env node
import { run } from "../src/cli.js";

run(process.argv).catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(err.exitCode || 1);
});
