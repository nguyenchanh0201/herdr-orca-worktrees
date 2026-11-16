const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeRepo } = require("./helpers/repo");
const { linkShared, copyIncludes, findOurSymlinks } = require("../src/fs-ops");

let primary;
let worktree;
let cleanup;

test.beforeEach(() => {
  const repo = makeRepo({
    gitignore: "node_modules/\n.cache/\n.env\nlink-env\n",
    files: { "tracked/a": "hello\n" },
    dirs: ["node_modules", ".cache"],
  });
  primary = repo.primary;
  worktree = repo.worktree;
  cleanup = repo.cleanup;
  fs.writeFileSync(path.join(primary, ".env"), "SECRET=1\n");
  fs.symlinkSync(".env", path.join(primary, "link-env"));
});

test.afterEach(() => {
  cleanup();
});

test("links ignored dirs, skips the rest", () => {
  const r = linkShared(primary, worktree, ["node_modules", "tracked", "nope", ".env"]);
  assert.deepEqual(r.linked, ["node_modules"]);
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules")), path.join(primary, "node_modules"));
  assert.deepEqual(r.skipped.map((s) => s.reason), ["not ignored", "missing", "not a directory"]);
});

test("never replaces an existing real directory", () => {
  fs.mkdirSync(path.join(worktree, ".cache"));
  fs.writeFileSync(path.join(worktree, ".cache/keep"), "1");
  assert.deepEqual(linkShared(primary, worktree, [".cache"]).skipped, [{ path: ".cache", reason: "exists" }]);
  assert.ok(fs.existsSync(path.join(worktree, ".cache/keep")));
});

test("copy follows top-level symlink, skips existing", () => {
  assert.deepEqual(copyIncludes(primary, worktree, [".env", "link-env"]).copied, [".env", "link-env"]);
  assert.equal(fs.lstatSync(path.join(worktree, "link-env")).isSymbolicLink(), false);
  assert.deepEqual(copyIncludes(primary, worktree, [".env"]).skipped, [{ path: ".env", reason: "exists" }]);
});

test("findOurSymlinks ignores real dirs", () => {
  linkShared(primary, worktree, ["node_modules"]);
  fs.mkdirSync(path.join(worktree, ".cache"));
  assert.deepEqual(findOurSymlinks(primary, worktree, ["node_modules", ".cache"]), [path.join(worktree, "node_modules")]);
});

test("findOurSymlinks: dangling and out-of-primary links are not ours", () => {
  fs.symlinkSync("/nonexistent/x", path.join(worktree, "node_modules"));
  fs.symlinkSync(os.tmpdir(), path.join(worktree, ".cache"));
  assert.deepEqual(findOurSymlinks(primary, worktree, ["node_modules", ".cache"]), []);
});
