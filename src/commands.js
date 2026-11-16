const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { readOrcaConfig, readWorktreeInclude } = require("./orca-config");
const { linkShared, copyIncludes, findOurSymlinks } = require("./fs-ops");
const { orcaEnv, buildRunner, writeRunner } = require("./runner");
const { gitInfo, claimFresh } = require("./git-info");

function requireLinked(folder) {
  if (!folder) return { error: "missing folder" };
  const g = gitInfo(folder);
  if (!g || !g.linked) return { error: "not a linked worktree" };
  return { g };
}

function dirtyLinesMinusOurs(worktree, ours) {
  const ourRels = new Set(
    ours.map((abs) => path.relative(worktree, abs).replace(/\\/g, "/")),
  );
  const r = spawnSync(
    "git",
    [
      "-C",
      worktree,
      "-c",
      "core.quotePath=false",
      "--no-optional-locks",
      "status",
      "--porcelain",
      "--untracked-files=all",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "git status failed").trim());
  }
  const lines = [];
  for (const raw of r.stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const rel = line.slice(3).replace(/\/+$/, "");
    if (line.startsWith("?? ") && ourRels.has(rel)) continue;
    lines.push(line);
  }
  return lines;
}

function lastLines(text, maxLines = 200) {
  if (!text) return "";
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (hasTrailingNewline) lines.pop();
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n") + (hasTrailingNewline ? "\n" : "");
}

function info(folder) {
  if (!folder) return { error: "missing folder" };
  const g = gitInfo(folder);
  if (!g) return { error: "not a git repository" };
  return { worktree: g.worktree, primary: g.primary, linked: g.linked };
}

function setup(folder) {
  const { g, error } = requireLinked(folder);
  if (error) return { error };

  if (!claimFresh(g.gitDir)) return { fresh: false };

  const primaryCfg = readOrcaConfig(g.primary);
  const sharedDirs = primaryCfg?.sharedDirectories ?? [];
  const includePaths = readWorktreeInclude(g.primary);

  const linkRes = linkShared(g.primary, g.worktree, sharedDirs);
  const copyRes = copyIncludes(g.primary, g.worktree, includePaths);
  const skipped = [...linkRes.skipped, ...copyRes.skipped];

  const wtCfg = readOrcaConfig(g.worktree);
  let runner = null;
  if (wtCfg?.setup) {
    const text = buildRunner({
      script: wtCfg.setup,
      primary: g.primary,
      worktree: g.worktree,
    });
    runner = writeRunner(text, path.basename(g.worktree));
  }

  return {
    fresh: true,
    linked: linkRes.linked,
    copied: copyRes.copied,
    skipped,
    runner,
  };
}

function preflight(folder) {
  const { g, error } = requireLinked(folder);
  if (error) return { error };

  const primaryCfg = readOrcaConfig(g.primary);
  const sharedDirs = primaryCfg?.sharedDirectories ?? [];
  const ours = findOurSymlinks(g.primary, g.worktree, sharedDirs);
  const dirty = dirtyLinesMinusOurs(g.worktree, ours);

  const branchRes = spawnSync("git", ["-C", g.worktree, "branch", "--show-current"], {
    encoding: "utf8",
  });
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : "";

  return {
    ours,
    dirty,
    archive: Boolean(primaryCfg?.archive),
    branch,
  };
}

function archive(folder) {
  const { g, error } = requireLinked(folder);
  if (error) return { error };

  const primaryCfg = readOrcaConfig(g.primary);
  const script = primaryCfg?.archive;
  if (!script) return { code: 0, output: "" };

  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd: g.worktree,
    env: { ...process.env, ...orcaEnv(g.primary, g.worktree) },
    timeout: 590_000,
    encoding: "utf8",
  });

  let combined = (r.stdout || "") + (r.stderr || "");
  if (r.error && !combined) combined = r.error.message;
  const code = r.status !== null ? r.status : 1;
  return { code, output: lastLines(combined, 200) };
}

function remove(folder, { force = false } = {}) {
  const { g, error } = requireLinked(folder);
  if (error) return { error };

  const primaryCfg = readOrcaConfig(g.primary);
  const sharedDirs = primaryCfg?.sharedDirectories ?? [];
  const ours = findOurSymlinks(g.primary, g.worktree, sharedDirs);

  if (!force) {
    const dirty = dirtyLinesMinusOurs(g.worktree, ours);
    if (dirty.length > 0) {
      return { ok: false, error: "uncommitted changes" };
    }
  }

  for (const linkPath of ours) {
    fs.unlinkSync(linkPath);
  }

  const args = ["-C", g.primary, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(g.worktree);

  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || "git worktree remove failed").trim(),
    };
  }
  return { ok: true };
}

module.exports = {
  info,
  setup,
  preflight,
  archive,
  remove,
};
