#!/usr/bin/env node
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  process.stdout.write((process.env.FAKE_AGY_VERSION || "1.5.0") + "\n");
  process.exit(0);
}

if (process.env.FAKE_AGY_MARKER) {
  fs.writeFileSync(process.env.FAKE_AGY_MARKER, "called");
}

if (process.env.FAKE_AGY_OUT) {
  process.stdout.write(fs.readFileSync(process.env.FAKE_AGY_OUT, "utf8"));
}

if (process.env.FAKE_AGY_ERR) {
  process.stderr.write(fs.readFileSync(process.env.FAKE_AGY_ERR, "utf8"));
}

process.exit(Number(process.env.FAKE_AGY_EXIT || 0));
