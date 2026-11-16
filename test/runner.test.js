const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { orcaEnv, buildRunner, writeRunner } = require("../src/runner");

test("orcaEnv", () => {
  assert.deepEqual(orcaEnv("/repo root", "/wt/my space"), {
    ORCA_ROOT_PATH: "/repo root",
    ORCA_WORKTREE_PATH: "/wt/my space",
    ORCA_WORKSPACE_NAME: "my space",
    CONDUCTOR_ROOT_PATH: "/repo root",
    GHOSTX_ROOT_PATH: "/repo root",
  });
});

test("buildRunner", () => {
  const s = buildRunner({ script: "#!/bin/bash -x\npnpm i", primary: "/r o", worktree: "/w t" });
  assert.match(s, /^#!\/usr\/bin\/env bash\nset -e\n/);
  assert.match(s, /set -x/);
  assert.match(s, /trap 'rm -f "\$0"' EXIT/);
  assert.match(s, /export ORCA_ROOT_PATH='\/r o'/);
  assert.match(s, /export ORCA_WORKSPACE_NAME='w t'/);
  assert.match(s, /export CONDUCTOR_ROOT_PATH='\/r o'/);
  assert.match(s, /cd '\/w t'/);
  assert.ok(s.trimEnd().endsWith("pnpm i"));
  assert.match(buildRunner({ script: "echo 'x'", primary: "/a", worktree: "/b" }), /echo 'x'/);
});

test("writeRunner creates executable 0700 file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-run-"));
  try {
    const p = writeRunner("#!/usr/bin/env bash\necho ok\n", "wt name", dir);
    assert.ok(p.startsWith(dir + path.sep));
    const st = fs.statSync(p);
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(p, "utf8"), "#!/usr/bin/env bash\necho ok\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
