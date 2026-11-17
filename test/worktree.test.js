const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { makeRepo } = require("./helpers/repo");
const {
  slug,
  SEA_CREATURES,
  suggestName,
  listBranches,
  addWorktree,
} = require("../src/worktree");

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function setupFixture() {
  const baseRepo = makeRepo({ gitignore: "" });
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-wt-fixture-")));
  const origin = path.join(tmpDir, "origin.git");
  const pusher = path.join(tmpDir, "pusher");
  const work = path.join(tmpDir, "work");
  const root = path.join(tmpDir, "worktrees");
  fs.mkdirSync(root, { recursive: true });

  const bare = spawnSync("git", ["clone", "--bare", baseRepo.primary, origin], { encoding: "utf8" });
  if (bare.status !== 0) throw new Error(`bare clone failed: ${bare.stderr}`);

  const pClone = spawnSync("git", ["clone", origin, pusher], { encoding: "utf8" });
  if (pClone.status !== 0) throw new Error(`pusher clone failed: ${pClone.stderr}`);
  git(pusher, ["config", "user.name", "t"]);
  git(pusher, ["config", "user.email", "t@t"]);
  git(pusher, ["checkout", "-b", "feat/remote-only"]);
  fs.writeFileSync(path.join(pusher, "remote.txt"), "remote\n");
  git(pusher, ["add", "-A"]);
  git(pusher, ["commit", "-m", "remote commit"]);
  git(pusher, ["push", "-u", "origin", "feat/remote-only"]);

  const wClone = spawnSync("git", ["clone", origin, work], { encoding: "utf8" });
  if (wClone.status !== 0) throw new Error(`work clone failed: ${wClone.stderr}`);
  git(work, ["config", "user.name", "t"]);
  git(work, ["config", "user.email", "t@t"]);
  const defaultBranch = git(work, ["rev-parse", "--abbrev-ref", "HEAD"]);
  git(work, ["branch", "fix/local"]);

  return {
    origin,
    work: fs.realpathSync(work),
    root: fs.realpathSync(root),
    defaultBranch,
    cleanup() {
      baseRepo.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

let fx;

test.beforeEach(() => {
  fx = setupFixture();
});

test.afterEach(() => {
  fx.cleanup();
});

test("branches lists local and remote", () => {
  const res = listBranches(fx.work, fx.root);
  assert.equal(res.error, undefined);
  assert.ok(res.local.includes(fx.defaultBranch));
  assert.ok(res.local.includes("fix/local"));
  assert.ok(res.remote.includes(`origin/${fx.defaultBranch}`));
  assert.ok(res.remote.includes("origin/feat/remote-only"));
  assert.ok(!res.remote.includes("origin/HEAD"));
  for (const b of [...res.local, ...res.remote]) {
    assert.ok(!b.startsWith("refs/heads/"));
  }
  assert.equal(res.default, fx.defaultBranch);
  assert.equal(res.checkedOut[fx.defaultBranch], fx.work);
  assert.ok(SEA_CREATURES.includes(res.suggested));
});

test("new name from local base", () => {
  const expectedHead = git(fx.work, ["rev-parse", "fix/local"]);
  const res = addWorktree(fx.work, { base: "fix/local", name: "try-x", root: fx.root });
  assert.equal(res.error, undefined);
  assert.equal(res.branch, "try-x");
  assert.equal(res.path, path.join(fx.root, "work", "try-x"));
  assert.equal(git(res.path, ["rev-parse", "HEAD"]), expectedHead);
});

test("new name from remote base has no upstream", () => {
  const res = addWorktree(fx.work, { base: "origin/feat/remote-only", name: "n1", root: fx.root });
  assert.equal(res.error, undefined);
  assert.equal(res.branch, "n1");
  const up = spawnSync("git", ["-C", res.path, "rev-parse", "--abbrev-ref", "n1@{upstream}"], { encoding: "utf8" });
  assert.notEqual(up.status, 0);
});

test("existing local name refused", () => {
  const res = addWorktree(fx.work, { base: fx.defaultBranch, name: "fix/local", root: fx.root });
  assert.ok(res.error);
  assert.match(res.error, /already exists/);
});

test("name equal to remote-only branch refused", () => {
  const res = addWorktree(fx.work, { base: fx.defaultBranch, name: "feat/remote-only", root: fx.root });
  assert.ok(res.error);
  assert.match(res.error, /exists on origin/);
});

test("invalid name refused", () => {
  const res = addWorktree(fx.work, { base: fx.defaultBranch, name: "bad..name", root: fx.root });
  assert.ok(res.error);
});

test("free local branch opens", () => {
  const res = addWorktree(fx.work, { base: "fix/local", root: fx.root });
  assert.equal(res.error, undefined);
  assert.equal(res.branch, "fix/local");
  assert.equal(res.path, path.join(fx.root, "work", "fix-local"));
  assert.equal(git(res.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "fix/local");
});

test("remote-only checks out tracking", () => {
  const res = addWorktree(fx.work, { base: "origin/feat/remote-only", root: fx.root });
  assert.equal(res.error, undefined);
  assert.equal(res.branch, "feat/remote-only");
  assert.equal(
    git(res.path, ["rev-parse", "--abbrev-ref", "feat/remote-only@{upstream}"]),
    "origin/feat/remote-only",
  );
});

test("remote with existing local uses local", () => {
  const first = addWorktree(fx.work, { base: "origin/feat/remote-only", root: fx.root });
  assert.equal(first.error, undefined);
  git(fx.work, ["worktree", "remove", first.path]);

  const second = addWorktree(fx.work, { base: "origin/feat/remote-only", root: fx.root });
  assert.equal(second.error, undefined);
  assert.equal(second.branch, "feat/remote-only");
  assert.equal(second.path, path.join(fx.root, "work", "feat-remote-only"));
});

test("default state creates generated branch", () => {
  const res = addWorktree(
    fx.work,
    { base: fx.defaultBranch, root: fx.root },
    { random: () => 0 },
  );
  assert.equal(res.error, undefined);
  assert.equal(res.branch, SEA_CREATURES[0]);
  assert.equal(res.path, path.join(fx.root, "work", SEA_CREATURES[0]));
  assert.ok(fs.existsSync(res.path));
});

test("suggestName skips used and suffixes", () => {
  assert.ok(SEA_CREATURES.length >= 50);
  const partial = new Set([SEA_CREATURES[0]]);
  assert.equal(suggestName(partial, () => 0), SEA_CREATURES[1]);

  const all = new Set(SEA_CREATURES);
  const suffixed = suggestName(all, () => 0);
  assert.ok(suffixed.endsWith("-2"));
});

test("existing path refused", () => {
  const dest = path.join(fx.root, "work", "try-x");
  fs.mkdirSync(dest, { recursive: true });
  const res = addWorktree(fx.work, { base: "fix/local", name: "try-x", root: fx.root });
  assert.ok(res.error);
});

test("slug", () => {
  assert.equal(slug("feat/x"), "feat-x");
});

test("CLI branches returns JSON with local", () => {
  const cliPath = path.resolve(__dirname, "../bin/orca-wt.js");
  const r = spawnSync(process.execPath, [cliPath, "branches", fx.work, "--root", fx.root], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.local));
  assert.ok(parsed.local.includes(fx.defaultBranch));
});
