const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { makeRepo } = require("./helpers/repo");
const {
  stateDir,
  listProjects,
  addProject,
  removeProject,
  seedProjects,
  defaultCloneName,
  cloneProject,
} = require("../src/projects");

const CLI = path.resolve(__dirname, "../bin/orca-wt.js");

let tmpStateDir;
let repo;
let extraDirs;

function mkTmp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  extraDirs.push(dir);
  return dir;
}

test.beforeEach(() => {
  extraDirs = [];
  tmpStateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-state-")));
  process.env.ORCA_WT_STATE_DIR = tmpStateDir;
  repo = makeRepo();
});

test.afterEach(() => {
  repo.cleanup();
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
  for (const d of extraDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  delete process.env.ORCA_WT_STATE_DIR;
});

test("list missing file", () => {
  assert.deepEqual(listProjects(), { projects: [], seeded: false });
});

test("add primary and worktree once", () => {
  assert.deepEqual(addProject(repo.primary), { path: repo.primary, added: true });
  assert.deepEqual(addProject(repo.worktree), { path: repo.primary, added: false });
  assert.deepEqual(listProjects(), {
    projects: [{ path: repo.primary, exists: true }],
    seeded: true,
  });
});

test("add non-git", () => {
  const nonGit = mkTmp("orca-nongit-");
  assert.deepEqual(addProject(nonGit), { error: "Not a git repository" });
});

test("remove", () => {
  addProject(repo.primary);
  assert.deepEqual(removeProject(repo.primary), { removed: true });
  assert.deepEqual(listProjects(), { projects: [], seeded: true });
  assert.deepEqual(removeProject(repo.primary), { removed: false });
});

test("seed once", () => {
  const nonGit = mkTmp("orca-nongit-");
  const r1 = seedProjects([repo.primary, nonGit]);
  assert.deepEqual(r1, { seeded: true, projects: [repo.primary] });

  const r2 = seedProjects([repo.primary, nonGit]);
  assert.deepEqual(r2, { seeded: false, projects: [repo.primary] });

  // Fresh state dir where addProject ran first -> seedProjects is a no-op
  const freshState = mkTmp("orca-state2-");
  process.env.ORCA_WT_STATE_DIR = freshState;
  addProject(repo.primary);
  const r3 = seedProjects([repo.primary]);
  assert.deepEqual(r3, { seeded: false, projects: [repo.primary] });
});

test("invalid json", () => {
  const file = path.join(stateDir(), "projects.json");
  fs.writeFileSync(file, "{nope", "utf8");

  const listed = listProjects();
  assert.ok(listed.error, "expected error on invalid JSON");
  assert.equal(fs.readFileSync(file, "utf8"), "{nope");

  const added = addProject(repo.primary);
  assert.deepEqual(added, { path: repo.primary, added: true });

  const entries = fs.readdirSync(stateDir());
  const badFile = entries.find((e) => e.startsWith("projects.json.bad-"));
  assert.ok(badFile, "expected projects.json.bad-* backup file");
  assert.equal(fs.readFileSync(path.join(stateDir(), badFile), "utf8"), "{nope");
});

test("missing folder", () => {
  const tmpCopyBase = mkTmp("orca-copy-");
  const copiedRepo = path.join(tmpCopyBase, "repo");
  const r = spawnSync("git", ["clone", repo.primary, copiedRepo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const realCopied = fs.realpathSync(copiedRepo);

  addProject(realCopied);
  fs.rmSync(realCopied, { recursive: true, force: true });

  assert.deepEqual(listProjects(), {
    projects: [{ path: realCopied, exists: false }],
    seeded: true,
  });
});

test("defaultCloneName", () => {
  assert.equal(defaultCloneName("https://github.com/a/b.git"), "b");
  assert.equal(defaultCloneName("https://github.com/a/b/"), "b");
  assert.equal(defaultCloneName("git@github.com:a/b.git"), "b");
  assert.equal(defaultCloneName("ssh://git@host/a/b"), "b");
});

test("clone local bare", () => {
  const tmpWork = mkTmp("orca-clone-");
  const bare = path.join(tmpWork, "src.git");
  const r = spawnSync("git", ["clone", "--bare", repo.primary, bare], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  const parentDir = path.join(tmpWork, "parent");
  fs.mkdirSync(parentDir);

  const res = cloneProject("file://" + bare, parentDir, "dst");
  const expectedDest = fs.realpathSync(path.join(parentDir, "dst"));
  assert.deepEqual(res, { path: expectedDest });
  assert.ok(fs.existsSync(path.join(expectedDest, ".git")));
  assert.deepEqual(listProjects(), {
    projects: [{ path: expectedDest, exists: true }],
    seeded: true,
  });
});

test("clone refuses", () => {
  const parentDir = mkTmp("orca-refuse-");
  const existing = path.join(parentDir, "taken");
  fs.mkdirSync(existing);

  const r1 = cloneProject("file:///nope.git", parentDir, "taken");
  assert.ok(r1.error && r1.error.includes("already exists"));

  for (const badName of ["a/b", "..", ""]) {
    const r = cloneProject("file:///nope.git", parentDir, badName);
    assert.ok(r.error, `expected error for name ${JSON.stringify(badName)}`);
  }

  const missingParent = path.join(parentDir, "does-not-exist");
  const rParent = cloneProject("file:///nope.git", missingParent, "ok");
  assert.ok(rParent.error);
});

test("clone bad url", () => {
  const parentDir = mkTmp("orca-badurl-");
  const res = cloneProject("file:///no/such/repo.git", parentDir, "x");
  assert.ok(res.error);
  assert.equal(fs.existsSync(path.join(parentDir, "x")), false);
});

test("clone fails fast without credentials", { skip: Boolean(process.env.CI_OFFLINE) }, () => {
  const parentDir = mkTmp("orca-fastfail-");
  const start = Date.now();
  const res = cloneProject(
    "https://github.com/this-org-does-not-exist-orca-wt/nope.git",
    parentDir,
    "y",
  );
  const elapsed = Date.now() - start;
  assert.ok(res.error, "expected error on missing remote repo");
  assert.ok(elapsed < 20000, `took too long: ${elapsed}ms`);
});

test("cli projects list", () => {
  const r = spawnSync(process.execPath, [CLI, "projects", "list"], {
    encoding: "utf8",
    env: { ...process.env, ORCA_WT_STATE_DIR: tmpStateDir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { projects: [], seeded: false });
});
