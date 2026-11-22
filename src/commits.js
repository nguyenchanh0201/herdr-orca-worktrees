const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

function gitRun(repo, args, opts = {}) {
  return spawnSync("git", ["--literal-pathspecs", "-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...opts });
}

// Status paths are always repository-relative, even when the selected folder
// is nested. Resolve that same root for every operation consuming those paths.
function repositoryRoot(repo) {
  if (!repo) return { error: "Missing repository path" };
  const res = gitRun(repo, ["rev-parse", "--show-toplevel"]);
  return res.status === 0
    ? { root: res.stdout.replace(/\n$/, "") }
    : { error: gitError(res, "Could not read repository") };
}

function listCommits(repo, { limit = 100 } = {}) {
  if (!repo) return { error: "Missing repository path" };
  const format = ["%H", "%h", "%an", "%ad", "%s"].join(FIELD_SEP) + RECORD_SEP;
  const res = gitRun(repo, [
    "log",
    `-n`,
    String(limit),
    `--date=short`,
    `--pretty=format:${format}`,
  ]);
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "git log failed").trim();
    // An empty repo (no commits yet) isn't an error, just nothing to list.
    if (/does not have any commits yet|unknown revision/i.test(msg)) return { commits: [] };
    return { error: msg };
  }
  const commits = (res.stdout || "")
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, short, author, date, ...rest] = record.split(FIELD_SEP);
      return { hash, short, author, date, subject: rest.join(FIELD_SEP) };
    });
  return { commits };
}

function diffArgs(repo, hash) {
  if (!repo) return { error: "Missing repository path" };
  if (!hash) return { error: "Missing commit hash" };
  if (hash === "UNSTAGED") return { args: ["diff"] };
  if (hash !== "WORKING" && hash !== "STAGED") {
    const res = gitRun(repo, ["rev-parse", "--verify", "--end-of-options", `${hash}^{commit}`]);
    if (res.status !== 0) return { error: (res.stderr || "Invalid commit").trim() };
    return { args: ["show", "--first-parent", "-m", "--format=", res.stdout.trim()] };
  }
  // A brand-new repo has no HEAD yet; diff against the empty tree instead.
  const hasHead = gitRun(repo, ["rev-parse", "--verify", "HEAD"]).status === 0;
  const base = hasHead ? "HEAD" : gitRun(repo, ["hash-object", "-t", "tree", "--stdin"], { input: "" }).stdout?.trim();
  if (!base) return { error: "Could not read repository" };
  return { args: ["diff", ...(hash === "STAGED" ? ["--cached"] : []), base] };
}

function commitFiles(repo, hash) {
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  const spec = diffArgs(repo, hash);
  if (spec.error) return spec;
  const res = gitRun(repo, [...spec.args, "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", "--"]);
  if (res.status !== 0) return { error: (res.stderr || res.error?.message || "git files failed").trim() };
  const parts = res.stdout.split("\0");
  const files = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) {
      const oldPath = parts[i++];
      files.push({ status: status[0], oldPath, path: parts[i++] });
    } else {
      files.push({ status: status[0], path: parts[i++] });
    }
  }
  return { files };
}

function commitDiff(repo, hash, file, oldPath) {
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  if (hash === "UNTRACKED") {
    const error = validatePaths(repo, [file]);
    if (error) return { error };
    const res = gitRun(repo, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", file], { cwd: repo });
    if (res.status !== 0 && res.status !== 1) return { error: gitError(res, "git diff failed") };
    return { diff: res.stdout };
  }
  const spec = diffArgs(repo, hash);
  if (spec.error) return spec;
  const paths = file ? [...(oldPath ? [oldPath] : []), file] : [];
  const res = gitRun(repo, [...spec.args, "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--patch", "--", ...paths]);
  if (res.status !== 0) return { error: (res.stderr || res.stdout || "git diff failed").trim() };
  return { diff: res.stdout };
}

function gitError(result, fallback) {
  return (result.stderr || result.error?.message || result.stdout || fallback).trim();
}

function gitStatus(repo) {
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  const res = gitRun(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (res.status !== 0) return { error: gitError(res, "git status failed") };
  const result = { branch: "", upstream: "", ahead: 0, behind: 0, staged: [], changes: [], untracked: [], conflicts: [] };
  const branch = gitRun(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  result.branch = branch.status === 0 ? branch.stdout.trim() : `${gitRun(repo, ["rev-parse", "--short", "HEAD"]).stdout.trim()} (detached)`;
  const upstream = gitRun(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream.status === 0) {
    result.upstream = upstream.stdout.trim();
    const counts = gitRun(repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (counts.status === 0) [result.ahead, result.behind] = counts.stdout.trim().split(/\s+/).map(Number);
  }
  const fields = res.stdout.split("\0");
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const entry = fields[i];
    const index = entry[0];
    const working = entry[1];
    const file = { path: entry.slice(3) };
    if (/[RC]/.test(index + working)) file.oldPath = fields[++i];
    if (index === "?" && working === "?") result.untracked.push({ status: "?", ...file });
    else if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(index + working)) result.conflicts.push({ status: "U", ...file });
    else {
      if (index !== " " && index !== "!") result.staged.push({ status: index, ...file });
      if (working !== " " && working !== "!") result.changes.push({ status: working, ...file });
    }
  }
  return result;
}

function validatePaths(repo, paths) {
  if (!repo) return "Missing repository path";
  for (const file of paths) {
    if (typeof file !== "string" || !file || file.includes("\0") || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      return "Expected a repository-relative file path";
    }
  }
  return null;
}

function gitStage(repo, file, oldPath) {
  let paths = file === undefined ? [] : [...(oldPath ? [oldPath] : []), file];
  const error = validatePaths(repo, paths);
  if (error) return { error };
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  if (file === undefined) {
    const status = gitStatus(repo);
    if (status.error) return status;
    // The Changes group excludes Merge Changes. Stage All must preserve that
    // boundary so unresolved conflicts require an explicit per-file action.
    paths = [...new Set([...status.changes, ...status.untracked].flatMap(entry => [...(entry.oldPath ? [entry.oldPath] : []), entry.path]))];
    if (!paths.length) return { ok: true };
  }
  const res = gitRun(repo, ["add", "-A", "--", ...paths]);
  return res.status === 0 ? { ok: true } : { error: gitError(res, "git stage failed") };
}

function gitUnstage(repo, file, oldPath) {
  const paths = file === undefined ? ["."] : [...(oldPath ? [oldPath] : []), file];
  const error = validatePaths(repo, paths);
  if (error) return { error };
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  const hasHead = gitRun(repo, ["rev-parse", "--verify", "HEAD"]).status === 0;
  const args = hasHead ? ["reset", "-q", "HEAD", "--", ...paths] : ["rm", "--cached", "-r", "-f", "--", ...paths];
  const res = gitRun(repo, args);
  return res.status === 0 ? { ok: true } : { error: gitError(res, "git unstage failed") };
}

function gitCommit(repo, message) {
  if (!repo) return { error: "Missing repository path" };
  if (typeof message !== "string" || !message.trim() || message.includes("\0")) return { error: "Enter a commit message" };
  const context = repositoryRoot(repo);
  if (context.error) return context;
  repo = context.root;
  const res = gitRun(repo, ["-c", "core.editor=true", "commit", "-m", message]);
  return res.status === 0 ? { ok: true } : { error: gitError(res, "git commit failed") };
}

// Read the current working file, never the index or historical blob. The host
// saves against this exact snapshot with writeTextFile's atomic comparison.
function gitFile(repo, file) {
  const error = validatePaths(repo, [file]);
  if (error) return { error };
  const context = repositoryRoot(repo);
  if (context.error) return context;
  try {
    const root = fs.realpathSync(context.root);
    const candidate = path.resolve(root, file);
    const absolute = fs.realpathSync(candidate);
    if (!absolute.startsWith(root + path.sep) || fs.lstatSync(candidate).isSymbolicLink()) {
      return { error: "Edit a regular file inside this repository" };
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return { error: "Only regular files can be edited" };
    if (stat.size > 1024 * 1024) return { error: "The editor supports files up to 1 MiB" };
    const bytes = fs.readFileSync(absolute);
    const content = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(content, "utf8").equals(bytes)) {
      return { error: "Binary or non-UTF-8 files cannot be edited as text" };
    }
    return { path: absolute, content };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { listCommits, commitFiles, commitDiff, gitStatus, gitStage, gitUnstage, gitCommit, gitFile };
