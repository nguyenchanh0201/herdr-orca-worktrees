const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { makeRepo } = require("./helpers/repo");

const CLI = path.resolve(__dirname, "../bin/orca-wt.js");

function runCli(args, homeDir) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: homeDir },
  });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

function gitExec(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

let tmpHome;
let repo;

test.beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orca-home-"));
  repo = makeRepo({
    gitignore: "node_modules/\n.cache/\n.env\n",
    files: {
      "orca.yaml": [
        "scripts:",
        "  setup: echo setup-ran",
        "  archive: echo archived",
        "worktree:",
        "  sharedDirectories: [node_modules, .cache]",
        "",
      ].join("\n"),
      ".worktreeinclude": ".env\n",
    },
    dirs: ["node_modules", ".cache"],
  });
  fs.writeFileSync(path.join(repo.primary, ".env"), "SECRET=1\n");
});

test.afterEach(() => {
  repo.cleanup();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("setup applies links, copies, creates runner once, second setup is no-op", () => {
  const res1 = runCli(["setup", repo.worktree], tmpHome);
  assert.equal(res1.fresh, true);
  assert.deepEqual(res1.linked, ["node_modules", ".cache"]);
  assert.deepEqual(res1.copied, [".env"]);
  assert.deepEqual(res1.skipped, []);
  assert.ok(res1.runner && fs.existsSync(res1.runner));
  assert.match(fs.readFileSync(res1.runner, "utf8"), /echo setup-ran/);

  const res2 = runCli(["setup", repo.worktree], tmpHome);
  assert.deepEqual(res2, { fresh: false });
});

test("setup when worktree orca.yaml lacks scripts.setup still links and returns runner: null", () => {
  const repo2 = makeRepo({
    gitignore: "node_modules/\n",
    files: {},
    dirs: ["node_modules"],
  });
  try {
    fs.writeFileSync(
      path.join(repo2.primary, "orca.yaml"),
      "scripts:\n  setup: echo later\nworktree:\n  sharedDirectories: [node_modules]\n",
    );
    gitExec(repo2.primary, ["add", "orca.yaml"]);
    gitExec(repo2.primary, ["commit", "-m", "add orca.yaml in primary only"]);

    const res = runCli(["setup", repo2.worktree], tmpHome);
    assert.equal(res.fresh, true);
    assert.deepEqual(res.linked, ["node_modules"]);
    assert.equal(res.runner, null);
  } finally {
    repo2.cleanup();
  }
});

test("preflight ignores our symlinks and reports untracked files", () => {
  runCli(["setup", repo.worktree], tmpHome);
  const p1 = runCli(["preflight", repo.worktree], tmpHome);
  assert.deepEqual(p1.dirty, []);
  assert.deepEqual(p1.ours, [
    path.join(repo.worktree, "node_modules"),
    path.join(repo.worktree, ".cache"),
  ]);
  assert.equal(p1.archive, true);
  assert.equal(p1.branch, "b1");

  fs.writeFileSync(path.join(repo.worktree, "scratch.txt"), "hi\n");
  const p2 = runCli(["preflight", repo.worktree], tmpHome);
  assert.deepEqual(p2.dirty, ["?? scratch.txt"]);
});

test("archive runs primary script and reports exit code", () => {
  const ok = runCli(["archive", repo.worktree], tmpHome);
  assert.deepEqual(ok, { code: 0, output: "archived\n" });

  fs.writeFileSync(path.join(repo.primary, "orca.yaml"), "scripts:\n  archive: exit 3\n");
  const fail = runCli(["archive", repo.worktree], tmpHome);
  assert.equal(fail.code, 3);
});

test("remove refuses dirty without --force, succeeds with --force, keeps primary & branch", () => {
  runCli(["setup", repo.worktree], tmpHome);
  fs.writeFileSync(path.join(repo.worktree, "scratch.txt"), "hi\n");

  const r1 = runCli(["remove", repo.worktree], tmpHome);
  assert.deepEqual(r1, { ok: false, error: "uncommitted changes" });
  assert.ok(fs.lstatSync(path.join(repo.worktree, "node_modules")).isSymbolicLink());

  const r2 = runCli(["remove", repo.worktree, "--force"], tmpHome);
  assert.deepEqual(r2, { ok: true });
  assert.equal(fs.existsSync(repo.worktree), false);
  assert.ok(fs.existsSync(path.join(repo.primary, "node_modules")));
  const branches = gitExec(repo.primary, ["branch"]);
  assert.match(branches, /\bb1\b/);
});

test("real dir at shared path in worktree leaves primary dir untouched on remove --force", () => {
  fs.rmSync(path.join(repo.primary, ".cache"), { recursive: true, force: true });
  fs.mkdirSync(path.join(repo.primary, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(repo.primary, ".cache/primary-keep"), "yes");

  fs.mkdirSync(path.join(repo.worktree, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(repo.worktree, ".cache/wt-file"), "1");

  runCli(["setup", repo.worktree], tmpHome);
  const r = runCli(["remove", repo.worktree, "--force"], tmpHome);
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(path.join(repo.primary, ".cache/primary-keep"), "utf8"), "yes");
});

test("preflight, archive, remove, remove --force refuse primary folder", () => {
  const marker = path.join(tmpHome, "archive-ran");
  fs.writeFileSync(
    path.join(repo.primary, "orca.yaml"),
    `scripts:\n  archive: touch '${marker}'\nworktree:\n  sharedDirectories: [node_modules]\n`,
  );
  fs.rmSync(path.join(repo.primary, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(path.join(repo.primary, ".cache"), path.join(repo.primary, "node_modules"));

  for (const args of [
    ["preflight", repo.primary],
    ["archive", repo.primary],
    ["remove", repo.primary],
    ["remove", repo.primary, "--force"],
  ]) {
    const res = runCli(args, tmpHome);
    assert.deepEqual(res, { error: "not a linked worktree" }, args.join(" "));
  }
  assert.ok(fs.lstatSync(path.join(repo.primary, "node_modules")).isSymbolicLink());
  assert.equal(fs.existsSync(marker), false);
});

test("info on non-git folder returns error", () => {
  const res = runCli(["info", os.tmpdir()], tmpHome);
  assert.ok(typeof res.error === "string" && res.error.length > 0);
});
