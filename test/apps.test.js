const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "../bin/orca-wt.js");
const apps = require("../src/apps");

let stateDir;
let tmpApps;
let prevStateDir;

test.beforeEach(() => {
  prevStateDir = process.env.ORCA_WT_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-apps-state-"));
  process.env.ORCA_WT_STATE_DIR = stateDir;
  tmpApps = fs.mkdtempSync(path.join(os.tmpdir(), "orca-apps-dir-"));
  for (const name of ["Visual Studio Code.app", "Zed.app", "Ghostty.app"]) {
    fs.mkdirSync(path.join(tmpApps, name));
  }
});

test.afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ORCA_WT_STATE_DIR;
  else process.env.ORCA_WT_STATE_DIR = prevStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(tmpApps, { recursive: true, force: true });
});

test("installedApps finds .app folders and always Finder", () => {
  assert.deepEqual(
    apps.installedApps([tmpApps]).map((a) => a.id),
    ["vscode", "zed", "ghostty", "finder"]
  );
});

test("listApps defaults to installed minus terminal and ghostty", () => {
  assert.deepEqual(apps.listApps({ dirs: [tmpApps] }).chosen, ["vscode", "zed", "finder"]);
});

test("setApps saves known ids; listApps hides uninstalled but keeps them in the file", () => {
  assert.deepEqual(apps.setApps(["zed", "xcode", "bogus"]).apps, ["zed", "xcode"]);
  assert.deepEqual(apps.listApps({ dirs: [tmpApps] }).chosen, ["zed"]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(stateDir, "apps.json"), "utf8")).apps,
    ["zed", "xcode"]
  );
});

test("openArgv", () => {
  assert.deepEqual(apps.openArgv("finder", "/x"), ["/x"]);
  assert.deepEqual(apps.openArgv("vscode", "/x"), ["-a", "Visual Studio Code", "/x"]);
  assert.equal(apps.openArgv("nope", "/x"), null);
});

test("openIn rejects a missing folder", () => {
  assert.ok(apps.openIn("finder", "/definitely/not/here").error);
});

test("CLI apps set and apps list", () => {
  const env = { ...process.env, ORCA_WT_STATE_DIR: stateDir };
  const setRes = spawnSync(process.execPath, [CLI, "apps", "set", "zed"], { encoding: "utf8", env });
  assert.equal(setRes.status, 0, setRes.stderr);
  assert.deepEqual(JSON.parse(setRes.stdout.trim()).apps, ["zed"]);

  const listRes = spawnSync(process.execPath, [CLI, "apps", "list"], { encoding: "utf8", env });
  assert.equal(listRes.status, 0, listRes.stderr);
  const parsed = JSON.parse(listRes.stdout.trim());
  assert.ok(Array.isArray(parsed.installed));
  assert.ok(Array.isArray(parsed.chosen));
});
