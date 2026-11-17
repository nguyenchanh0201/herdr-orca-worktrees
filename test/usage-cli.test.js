const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { fetchAll } = require("../src/usage");

const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "orca-wt.js");
const FAKE_CODEX = path.join(__dirname, "fixtures", "usage", "fake-codex.js");

function makeStubDeps(overrides = {}) {
  return {
    claude: async () => ({ id: "claude", status: "ok", windows: [], fetchedAt: 1 }),
    codex: async () => ({ id: "codex", status: "ok", windows: [], fetchedAt: 2 }),
    agy: async () => ({ id: "agy", status: "ok", windows: [], fetchedAt: 3 }),
    ...overrides,
  };
}

describe("fetchAll", () => {
  it("fetches all three providers in order (claude, codex, agy)", async () => {
    const res = await fetchAll({ deps: makeStubDeps() });
    assert.deepEqual(
      res.providers.map((p) => p.id),
      ["claude", "codex", "agy"]
    );
  });

  it("excludes providers listed in skip", async () => {
    const res = await fetchAll({ skip: ["agy"], deps: makeStubDeps() });
    assert.deepEqual(
      res.providers.map((p) => p.id),
      ["claude", "codex"]
    );
  });

  it("filters to a single provider when only is set", async () => {
    const res = await fetchAll({ only: "codex", deps: makeStubDeps() });
    assert.deepEqual(
      res.providers.map((p) => p.id),
      ["codex"]
    );
  });

  it("catches a throwing provider stub and returns error status without failing others", async () => {
    const before = Date.now();
    const res = await fetchAll({
      deps: makeStubDeps({
        codex: async () => {
          throw new Error("boom");
        },
      }),
    });
    const after = Date.now();

    assert.equal(res.providers.length, 3);
    assert.equal(res.providers[0].status, "ok");
    assert.equal(res.providers[2].status, "ok");

    const codex = res.providers[1];
    assert.equal(codex.id, "codex");
    assert.equal(codex.status, "error");
    assert.equal(codex.error, "Couldn't read usage");
    assert.deepEqual(codex.windows, []);
    assert.equal(typeof codex.fetchedAt, "number");
    assert.ok(codex.fetchedAt >= before && codex.fetchedAt <= after);
  });
});

describe("orca-wt usage CLI", () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs usage --only codex using fake-codex on PATH", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-wt-usage-"));
    tempDirs.push(tmpDir);
    fs.symlinkSync(FAKE_CODEX, path.join(tmpDir, "codex"));

    const proc = spawnSync(
      process.execPath,
      [CLI_PATH, "usage", "--only", "codex"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${tmpDir}:${process.env.PATH}`,
          FAKE_CODEX_MODE: "ok",
        },
        encoding: "utf8",
      }
    );

    assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.providers.length, 1);
    assert.equal(parsed.providers[0].id, "codex");
    assert.equal(parsed.providers[0].status, "ok");
    assert.equal(parsed.providers[0].windows.length, 2);
  });
});
