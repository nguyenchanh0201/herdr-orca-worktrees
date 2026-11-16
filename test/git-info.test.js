const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");

const { makeRepo } = require("./helpers/repo");
const { gitInfo, claimFresh } = require("../src/git-info");

let primary;
let worktree;
let cleanup;

test.beforeEach(() => {
  const repo = makeRepo({ gitignore: "" });
  primary = repo.primary;
  worktree = repo.worktree;
  cleanup = repo.cleanup;
});

test.afterEach(() => {
  cleanup();
});

test("gitInfo", () => {
  const { worktree: w, primary: p, linked } = gitInfo(worktree);
  assert.deepEqual({ w, p, linked }, { w: worktree, p: primary, linked: true });
  assert.equal(gitInfo(primary).linked, false);
  assert.equal(gitInfo(fs.realpathSync(os.tmpdir())), null);
});

test("claimFresh once, then never", () => {
  const { gitDir } = gitInfo(worktree);
  assert.equal(claimFresh(gitDir), true);
  assert.equal(claimFresh(gitDir), false);
});

test("old admin dir is not fresh", () => {
  assert.equal(claimFresh(gitInfo(worktree).gitDir, Date.now() + 11 * 60_000), false);
});
