const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let seq = 0;

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function orcaEnv(primary, worktree) {
  return {
    ORCA_ROOT_PATH: primary,
    ORCA_WORKTREE_PATH: worktree,
    ORCA_WORKSPACE_NAME: path.basename(worktree),
    CONDUCTOR_ROOT_PATH: primary,
    GHOSTX_ROOT_PATH: primary,
  };
}

function buildRunner({ script, primary, worktree }) {
  const lines = String(script).split(/\r?\n/);
  let flags = null;
  if (lines.length > 0) {
    const match = lines[0].match(/^#!\S*(?:bash|sh)\s+(-\w+)/);
    if (match) {
      flags = match[1];
      lines.shift();
    }
  }

  const env = orcaEnv(primary, worktree);
  const out = [
    "#!/usr/bin/env bash",
    "set -e",
  ];
  if (flags) out.push(`set ${flags}`);
  out.push("trap 'rm -f \"$0\"' EXIT");
  for (const [k, v] of Object.entries(env)) {
    out.push(`export ${k}=${shellQuote(v)}`);
  }
  out.push(`cd ${shellQuote(worktree)}`);
  out.push(lines.join("\n"));

  return out.join("\n") + "\n";
}

function writeRunner(text, name, dir) {
  const targetDir =
    dir || path.join(process.env.HOME || os.homedir(), ".local", "state", "orca-worktrees", "runs");
  fs.mkdirSync(targetDir, { recursive: true });
  const safeName = String(name || "run").replace(/[^a-zA-Z0-9._-]+/g, "_") || "run";
  const fileName = `${safeName}-${Date.now()}-${process.pid}-${++seq}.sh`;
  const filePath = path.join(targetDir, fileName);
  fs.writeFileSync(filePath, text, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
  return filePath;
}

module.exports = {
  orcaEnv,
  buildRunner,
  writeRunner,
};
