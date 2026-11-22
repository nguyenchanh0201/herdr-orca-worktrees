const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { makeRepo } = require("./helpers/repo");
const { listCommits, commitFiles, commitDiff, gitStatus, gitStage, gitUnstage, gitCommit, gitFile } = require("../src/commits");

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

let fx;

test.beforeEach(() => {
  fx = makeRepo({ files: { "a.txt": "one\n" } });
});

test.afterEach(() => {
  fx.cleanup();
});

test("listCommits returns newest-first commits with hash, author and subject", () => {
  fs.writeFileSync(path.join(fx.primary, "b.txt"), "two\n");
  git(fx.primary, ["add", "-A"]);
  git(fx.primary, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "second commit"]);

  const res = listCommits(fx.primary);
  assert.equal(res.error, undefined);
  assert.equal(res.commits.length, 2);
  assert.equal(res.commits[0].subject, "second commit");
  assert.equal(res.commits[1].subject, "init");
  assert.match(res.commits[0].hash, /^[0-9a-f]{40}$/);
  assert.equal(res.commits[0].author, "t");
});

test("listCommits respects limit", () => {
  const res = listCommits(fx.primary, { limit: 1 });
  assert.equal(res.commits.length, 1);
});

test("listCommits errors for a missing repository", () => {
  const res = listCommits(path.join(fx.primary, "does-not-exist"));
  assert.ok(res.error);
});

test("commitDiff shows a commit's patch", () => {
  const hash = git(fx.primary, ["rev-parse", "HEAD"]);
  const res = commitDiff(fx.primary, hash);
  assert.equal(res.error, undefined);
  assert.match(res.diff, /a\.txt/);
  assert.match(res.diff, /\+one/);
});

test("commitFiles lists root-commit additions", () => {
  assert.deepEqual(commitFiles(fx.primary, "HEAD"), { files: [
    { status: "A", path: ".gitignore" }, { status: "A", path: "a.txt" },
  ] });
});

test("commitFiles and per-file diffs preserve rename paths and literal filenames", () => {
  git(fx.primary, ["mv", "a.txt", "renamed file.txt"]);
  fs.writeFileSync(path.join(fx.primary, "[special].txt"), "literal\n");
  fs.writeFileSync(path.join(fx.primary, "s.txt"), "other\n");
  git(fx.primary, ["add", "-A"]);
  git(fx.primary, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "rename"]);
  const res = commitFiles(fx.primary, "HEAD");
  assert.equal(res.error, undefined);
  const renamed = res.files.find(f => f.status === "R");
  assert.deepEqual(renamed, { status: "R", oldPath: "a.txt", path: "renamed file.txt" });
  const diff = commitDiff(fx.primary, "HEAD", renamed.path, renamed.oldPath);
  assert.match(diff.diff, /rename from a.txt/);
  assert.match(diff.diff, /rename to renamed file.txt/);
  const literal = commitDiff(fx.primary, "HEAD", "[special].txt");
  assert.match(literal.diff, /\+literal/);
  assert.doesNotMatch(literal.diff, /\+other/);
});

test("working-tree file selection includes staged additions, modifications and deletions", () => {
  fs.unlinkSync(path.join(fx.primary, "a.txt"));
  fs.writeFileSync(path.join(fx.primary, "--new.txt"), "new\n");
  git(fx.primary, ["add", "--", "--new.txt"]);
  assert.deepEqual(commitFiles(fx.primary, "WORKING"), { files: [
    { status: "A", path: "--new.txt" }, { status: "D", path: "a.txt" },
  ] });
  const res = commitDiff(fx.primary, "WORKING", "--new.txt");
  assert.match(res.diff, /\+new/);
  assert.doesNotMatch(res.diff, /deleted file mode/);
  const cli = spawnSync(process.execPath, [path.join(__dirname, "../bin/orca-wt.js"), "commit-diff", fx.primary, "WORKING", "--new.txt"], { encoding: "utf8" });
  assert.equal(JSON.parse(cli.stdout).diff, res.diff);
});

test("commitDiff for WORKING shows uncommitted changes against HEAD", () => {
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "one\nmore\n");
  const res = commitDiff(fx.primary, "WORKING");
  assert.equal(res.error, undefined);
  assert.match(res.diff, /\+more/);
});

test("commitDiff shows merge changes against the first parent", () => {
  git(fx.primary, ["checkout", "-b", "feature"]);
  fs.writeFileSync(path.join(fx.primary, "feature.txt"), "feature\n");
  git(fx.primary, ["add", "-A"]);
  git(fx.primary, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "feature"]);
  git(fx.primary, ["checkout", "-"]);
  git(fx.primary, ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "feature", "-m", "merge"]);
  const res = commitDiff(fx.primary, git(fx.primary, ["rev-parse", "HEAD"]));
  assert.equal(res.error, undefined);
  assert.match(res.diff, /\+feature/);
  assert.deepEqual(commitFiles(fx.primary, "HEAD").files, [{ status: "A", path: "feature.txt" }]);
});

test("commitDiff on a repo with no commits yet diffs against the empty tree", () => {
  const empty = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "orca-wt-empty-"));
  spawnSync("git", ["init", empty], { encoding: "utf8" });
  fs.writeFileSync(path.join(empty, "x.txt"), "x\n");
  git(empty, ["add", "-A"]);
  fs.writeFileSync(path.join(empty, "x.txt"), "x\nlatest\n");

  const res = commitDiff(empty, "WORKING");
  assert.deepEqual(commitFiles(empty, "WORKING").files, [{ status: "A", path: "x.txt" }]);
  fs.rmSync(empty, { recursive: true, force: true });
  assert.equal(res.error, undefined);
  assert.match(res.diff, /x\.txt/);
  assert.match(res.diff, /\+latest/);
});

test("source control keeps staged and working versions separate, including literal untracked names", () => {
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "staged\n");
  assert.deepEqual(gitStage(fx.primary, "a.txt"), { ok: true });
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "working\n");
  const literal = "--[new]\nfile.txt";
  fs.writeFileSync(path.join(fx.primary, literal), "untracked\n");
  const status = gitStatus(fx.primary);
  assert.equal(status.error, undefined);
  assert.equal(status.branch, git(fx.primary, ["branch", "--show-current"]));
  assert.deepEqual(status.staged, [{ status: "M", path: "a.txt" }]);
  assert.deepEqual(status.changes, [{ status: "M", path: "a.txt" }]);
  assert.deepEqual(status.untracked, [{ status: "?", path: literal }]);
  assert.match(commitDiff(fx.primary, "STAGED", "a.txt").diff, /\+staged/);
  assert.doesNotMatch(commitDiff(fx.primary, "STAGED", "a.txt").diff, /\+working/);
  assert.match(commitDiff(fx.primary, "UNSTAGED", "a.txt").diff, /-staged\n\+working/);
  assert.match(commitDiff(fx.primary, "UNTRACKED", literal).diff, /\+untracked/);
  assert.deepEqual(gitStage(fx.primary, literal), { ok: true });
  assert.deepEqual(gitUnstage(fx.primary, literal), { ok: true });
  assert.equal(fs.readFileSync(path.join(fx.primary, literal), "utf8"), "untracked\n");
});

test("source control preserves rename paths and unstages both sides without deleting files", () => {
  git(fx.primary, ["mv", "a.txt", "renamed file.txt"]);
  const renamed = gitStatus(fx.primary).staged[0];
  assert.deepEqual(renamed, { status: "R", path: "renamed file.txt", oldPath: "a.txt" });
  assert.deepEqual(gitUnstage(fx.primary, renamed.path, renamed.oldPath), { ok: true });
  assert.equal(fs.readFileSync(path.join(fx.primary, renamed.path), "utf8"), "one\n");
  assert.deepEqual(gitStatus(fx.primary).staged, []);
  assert.deepEqual(gitStage(fx.primary, renamed.path, renamed.oldPath), { ok: true });
  assert.deepEqual(gitStatus(fx.primary).staged, [renamed]);
});

test("stage all and commit include only the staged version with a literal multiline message", () => {
  fs.writeFileSync(path.join(fx.primary, "new.txt"), "new\n");
  assert.deepEqual(gitStage(fx.primary), { ok: true });
  fs.writeFileSync(path.join(fx.primary, "new.txt"), "later\n");
  const message = "--literal `message` $(safe)\n\nbody";
  assert.deepEqual(gitCommit(fx.primary, message), { ok: true });
  assert.equal(git(fx.primary, ["show", "HEAD:new.txt"]), "new");
  assert.equal(git(fx.primary, ["log", "-1", "--format=%B"]), message);
  assert.equal(gitStatus(fx.primary).changes[0].path, "new.txt");
  assert.ok(gitCommit(fx.primary, " ").error);
  assert.ok(gitCommit(fx.primary, "nothing staged").error);
});

test("unstage all in an unborn repository keeps staged and subsequently edited files", () => {
  const empty = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "orca-wt-unborn-"));
  try {
    git(empty, ["init"]);
    fs.writeFileSync(path.join(empty, "new.txt"), "new\n");
    assert.deepEqual(gitStage(empty), { ok: true });
    assert.deepEqual(gitStatus(empty).staged, [{ status: "A", path: "new.txt" }]);
    assert.match(commitDiff(empty, "STAGED", "new.txt").diff, /\+new/);
    fs.writeFileSync(path.join(empty, "new.txt"), "edited\n");
    assert.deepEqual(gitUnstage(empty), { ok: true });
    assert.equal(fs.readFileSync(path.join(empty, "new.txt"), "utf8"), "edited\n");
    assert.deepEqual(gitStatus(empty).staged, []);
    assert.equal(gitStatus(empty).untracked[0].path, "new.txt");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("source control reports conflicts outside the ordinary staged and change groups", () => {
  git(fx.primary, ["checkout", "-b", "conflicting"]);
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "feature\n");
  gitStage(fx.primary);
  gitCommit(fx.primary, "feature");
  git(fx.primary, ["checkout", "-"]);
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "main\n");
  gitStage(fx.primary);
  gitCommit(fx.primary, "main");
  assert.notEqual(spawnSync("git", ["-C", fx.primary, "merge", "conflicting"]).status, 0);
  const status = gitStatus(fx.primary);
  assert.deepEqual(status.conflicts, [{ status: "U", path: "a.txt" }]);
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.changes, []);
  fs.writeFileSync(path.join(fx.primary, "ordinary.txt"), "ordinary\n");
  assert.deepEqual(gitStage(fx.primary), { ok: true });
  const afterStageAll = gitStatus(fx.primary);
  assert.deepEqual(afterStageAll.conflicts, status.conflicts);
  assert.deepEqual(afterStageAll.staged, [{ status: "A", path: "ordinary.txt" }]);
  assert.deepEqual(gitStage(fx.primary), { ok: true });
  assert.deepEqual(gitStatus(fx.primary).conflicts, status.conflicts);
  assert.deepEqual(gitStage(fx.primary, "a.txt"), { ok: true });
  assert.deepEqual(gitStatus(fx.primary).conflicts, []);
});

test("source control counts commits ahead and behind upstream", () => {
  git(fx.primary, ["branch", "--set-upstream-to=b1"]);
  fs.writeFileSync(path.join(fx.primary, "local.txt"), "local\n");
  gitStage(fx.primary);
  gitCommit(fx.primary, "local");
  fs.writeFileSync(path.join(fx.worktree, "upstream.txt"), "upstream\n");
  gitStage(fx.worktree);
  gitCommit(fx.worktree, "upstream");
  const status = gitStatus(fx.primary);
  assert.equal(status.upstream, "b1");
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 1);
});

test("source control CLI handles leading dashes literally and rejects escaping paths", () => {
  fs.writeFileSync(path.join(fx.primary, "--new.txt"), "new\n");
  const cli = (command, ...args) => JSON.parse(spawnSync(process.execPath, [path.join(__dirname, "../bin/orca-wt.js"), command, fx.primary, ...args], { encoding: "utf8" }).stdout);
  assert.deepEqual(cli("git-stage", "--new.txt"), { ok: true });
  assert.equal(cli("git-status").staged[0].path, "--new.txt");
  assert.deepEqual(cli("git-unstage", "--new.txt"), { ok: true });
  assert.ok(cli("git-stage", "../outside").error);
  assert.ok(cli("git-stage", "/tmp/outside").error);
  assert.ok(commitDiff(fx.primary, "UNTRACKED", "../outside").error);
});

test("nested folder contexts use repository-relative paths for status, diffs and actions", () => {
  const nested = path.join(fx.primary, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "inner.txt"), "inner\n");
  fs.writeFileSync(path.join(fx.primary, "root.txt"), "root\n");
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "changed\n");
  assert.deepEqual(gitStatus(nested), gitStatus(fx.primary));
  assert.match(commitDiff(nested, "UNTRACKED", "nested/inner.txt").diff, /\+inner/);
  assert.match(commitDiff(nested, "UNTRACKED", "root.txt").diff, /\+root/);
  assert.match(commitDiff(nested, "UNSTAGED", "a.txt").diff, /\+changed/);
  assert.deepEqual(gitStage(nested, "a.txt"), { ok: true });
  assert.match(commitDiff(nested, "STAGED", "a.txt").diff, /\+changed/);
  assert.deepEqual(gitUnstage(nested, "a.txt"), { ok: true });
  assert.deepEqual(gitStage(nested), { ok: true });
  assert.deepEqual(gitStatus(nested).staged.map(file => file.path), ["a.txt", "nested/inner.txt", "root.txt"]);
  assert.deepEqual(gitUnstage(nested), { ok: true });
  assert.deepEqual(gitStatus(nested).staged, []);
  assert.deepEqual(gitStage(nested), { ok: true });
  assert.deepEqual(gitCommit(nested, "from nested folder"), { ok: true });
  assert.deepEqual(commitFiles(nested, "HEAD"), commitFiles(fx.primary, "HEAD"));
  assert.match(commitDiff(nested, "HEAD", "root.txt").diff, /\+root/);
});


test("gitFile reads exact working text from nested contexts without altering the index", () => {
  fs.mkdirSync(path.join(fx.primary, "nested"));
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "working\r\ntext\twith tabs\r\n");
  const res = gitFile(path.join(fx.primary, "nested"), "a.txt");
  assert.equal(res.content, "working\r\ntext\twith tabs\r\n");
  assert.equal(res.path, fs.realpathSync(path.join(fx.primary, "a.txt")));
  assert.equal(git(fx.primary, ["show", ":a.txt"]), "one");
});

test("gitFile rejects binary, oversized, symlink, and escaping files", () => {
  fs.writeFileSync(path.join(fx.primary, "binary"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(fx.primary, "invalid-utf8"), Buffer.from([255]));
  fs.writeFileSync(path.join(fx.primary, "large"), "a".repeat(1024 * 1024 + 1));
  fs.symlinkSync(path.join(fx.primary, "a.txt"), path.join(fx.primary, "link"));
  for (const file of ["binary", "invalid-utf8", "large", "link", "../outside", "/absolute", "."]) {
    assert.ok(gitFile(fx.primary, file).error, file);
  }
});


test("line counts distinguish index, working tree, literal untracked names and binary files", () => {
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "staged\nsecond\n");
  git(fx.primary, ["add", "a.txt"]);
  fs.writeFileSync(path.join(fx.primary, "a.txt"), "working\n");
  fs.writeFileSync(path.join(fx.primary, "new\tfile.txt"), "new\nfile\n");
  fs.writeFileSync(path.join(fx.primary, "binary"), Buffer.from([0, 1, 2]));
  const status = gitStatus(fx.primary);
  assert.deepEqual(status.stats.staged["a.txt"], {add: 2, del: 1, binary: false});
  assert.deepEqual(status.stats.working["a.txt"], {add: 1, del: 2, binary: false});
  assert.deepEqual(status.stats.untracked["new\tfile.txt"], {add: 2, del: 0});
  assert.deepEqual(status.stats.untracked.binary, {binary: true});
  assert.equal(status.root, fs.realpathSync(fx.primary));
});

test("line counts parse NUL-delimited rename paths", () => {
  git(fx.primary, ["mv", "a.txt", "renamed\tfile.txt"]);
  assert.deepEqual(gitStatus(fx.primary).stats.staged["renamed\tfile.txt"], {add: 0, del: 0, binary: false});
});
