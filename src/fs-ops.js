const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function isIgnored(repo, rel) {
  const r = spawnSync("git", ["-C", repo, "check-ignore", "-q", "--", rel], {
    stdio: "ignore",
  });
  return r.status === 0;
}

function pathExistsLstat(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function linkShared(primary, worktree, dirs) {
  const linked = [];
  const skipped = [];

  for (const rel of dirs) {
    const src = path.join(primary, rel);
    const dest = path.join(worktree, rel);

    let st;
    try {
      st = fs.statSync(src);
    } catch {
      skipped.push({ path: rel, reason: "missing" });
      continue;
    }

    if (!st.isDirectory()) {
      skipped.push({ path: rel, reason: "not a directory" });
      continue;
    }

    if (!isIgnored(primary, rel)) {
      skipped.push({ path: rel, reason: "not ignored" });
      continue;
    }

    if (pathExistsLstat(dest)) {
      skipped.push({ path: rel, reason: "exists" });
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.symlinkSync(src, dest, "dir");
    linked.push(rel);
  }

  return { linked, skipped };
}

function copyPath(src, dest) {
  if (process.platform === "darwin") {
    const clone = spawnSync("cp", ["-cRH", src, dest], { stdio: "ignore" });
    if (clone.status === 0) return true;
  }
  const copy = spawnSync("cp", ["-RH", src, dest], { stdio: "ignore" });
  return copy.status === 0;
}

// shortcut: no Orca copy budget (2 GiB / 50k entries), add one if worktree creation gets slow
function copyIncludes(primary, worktree, paths) {
  const copied = [];
  const skipped = [];

  for (const rel of paths) {
    const src = path.join(primary, rel);
    const dest = path.join(worktree, rel);

    try {
      fs.statSync(src);
    } catch {
      skipped.push({ path: rel, reason: "missing" });
      continue;
    }

    if (!isIgnored(primary, rel)) {
      skipped.push({ path: rel, reason: "not ignored" });
      continue;
    }

    if (pathExistsLstat(dest)) {
      skipped.push({ path: rel, reason: "exists" });
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!copyPath(src, dest)) {
      skipped.push({ path: rel, reason: "copy failed" });
      continue;
    }
    copied.push(rel);
  }

  return { copied, skipped };
}

function findOurSymlinks(primary, worktree, dirs) {
  let primaryReal;
  try {
    primaryReal = fs.realpathSync(primary);
  } catch {
    return [];
  }
  const prefix = primaryReal.endsWith(path.sep) ? primaryReal : primaryReal + path.sep;
  const ours = [];

  for (const rel of dirs) {
    const dest = path.join(worktree, rel);
    let st;
    try {
      st = fs.lstatSync(dest);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;

    let targetReal;
    try {
      targetReal = fs.realpathSync(dest);
    } catch {
      continue;
    }
    if (targetReal.startsWith(prefix)) {
      ours.push(dest);
    }
  }

  return ours;
}

module.exports = {
  isIgnored,
  linkShared,
  copyIncludes,
  findOurSymlinks,
};
