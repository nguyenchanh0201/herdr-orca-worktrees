const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function gitExec(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function makeRepo({ gitignore = "", files = {}, dirs = [] } = {}) {
  const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca wt ")));
  const primaryRaw = path.join(tmpBase, "primary repo");
  const worktreeRaw = path.join(tmpBase, "wt dir");
  fs.mkdirSync(primaryRaw, { recursive: true });

  const init = spawnSync("git", ["init", primaryRaw], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);

  gitExec(primaryRaw, ["config", "user.name", "t"]);
  gitExec(primaryRaw, ["config", "user.email", "t@t"]);

  fs.writeFileSync(path.join(primaryRaw, ".gitignore"), gitignore);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(primaryRaw, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  gitExec(primaryRaw, ["add", "-A"]);
  gitExec(primaryRaw, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);

  for (const rel of dirs) {
    fs.mkdirSync(path.join(primaryRaw, rel), { recursive: true });
  }

  gitExec(primaryRaw, ["worktree", "add", "-b", "b1", worktreeRaw]);

  return {
    primary: fs.realpathSync(primaryRaw),
    worktree: fs.realpathSync(worktreeRaw),
    cleanup() {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    },
  };
}

module.exports = { makeRepo };
