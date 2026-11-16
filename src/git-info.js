const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function gitInfo(folder) {
  if (!folder) return null;
  const r = spawnSync(
    "git",
    ["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  const lines = r.stdout.trim().split(/\r?\n/);
  if (lines.length < 3) return null;

  try {
    const worktree = fs.realpathSync(lines[0]);
    const gitDir = fs.realpathSync(lines[1]);
    const commonDir = fs.realpathSync(lines[2]);
    const primary = fs.realpathSync(path.dirname(commonDir));
    const linked = gitDir !== commonDir;
    return { worktree, primary, gitDir, linked };
  } catch {
    return null;
  }
}

function claimFresh(gitDir, now = Date.now(), windowMs = 600_000) {
  let st;
  try {
    st = fs.statSync(gitDir);
  } catch {
    return false;
  }
  const createdMs = st.birthtimeMs || st.ctimeMs;
  if (now - createdMs >= windowMs) return false;

  const marker = path.join(gitDir, "orca-setup-done");
  try {
    const fd = fs.openSync(marker, "wx");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
}

module.exports = {
  gitInfo,
  claimFresh,
};
