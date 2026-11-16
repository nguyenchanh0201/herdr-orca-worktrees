const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeRelPath,
  parseOrcaYaml,
  parseWorktreeInclude,
  readOrcaConfig,
  readWorktreeInclude,
} = require("../src/orca-config");

test("normalizeRelPath", () => {
  assert.equal(normalizeRelPath("./node_modules/"), "node_modules");
  assert.equal(normalizeRelPath("a\\b"), "a/b");
  for (const bad of ["/abs", "C:/x", "a//b", "a/../b", "./.", ".git/x", "a/.git"])
    assert.equal(normalizeRelPath(bad), null, bad);
});

test("parseOrcaYaml reads fields", () => {
  assert.deepEqual(
    parseOrcaYaml("scripts:\n  setup: |\n    pnpm i\n  archive: echo bye\nworktree:\n  sharedDirectories: [./.cache/, .cache, node_modules]\n"),
    { setup: "pnpm i", archive: "echo bye", sharedDirectories: [".cache", "node_modules"] });
});

test("whole-file rejections", () => {
  assert.equal(parseOrcaYaml("scripts: {}\nscripts: {}\n"), null);
  assert.equal(parseOrcaYaml("a: [\n"), null);
  assert.equal(parseOrcaYaml("- a\n"), null);
  assert.equal(parseOrcaYaml("x: " + "a".repeat(262_145)), null);
});

test("bad field dropped, siblings kept", () => {
  assert.deepEqual(parseOrcaYaml("scripts:\n  setup: 42\n  archive: '  '\nworktree:\n  sharedDirectories: [.cache]\n"), { sharedDirectories: [".cache"] });
  assert.deepEqual(parseOrcaYaml(`scripts:\n  setup: "${"a".repeat(65_537)}"\n`), { sharedDirectories: [] });
});

test("only first 100 sharedDirectories", () => {
  const list = Array.from({ length: 101 }, (_, i) => `d${i}`);
  assert.equal(parseOrcaYaml(`worktree:\n  sharedDirectories: [${list}]\n`).sharedDirectories.length, 100);
});

test("parseWorktreeInclude", () => {
  assert.deepEqual(parseWorktreeInclude("# c\n\n.env\n./.env\n*.log\n!x\na?b\n../up\n.vscode/settings.json # kept\n"),
    [".env", ".vscode/settings.json # kept"]);
});

test("readOrcaConfig and readWorktreeInclude on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-cfg-"));
  try {
    assert.equal(readOrcaConfig(dir), null);
    assert.deepEqual(readWorktreeInclude(dir), []);

    fs.writeFileSync(path.join(dir, "orca.yaml"), "scripts:\n  setup: echo hi\n");
    fs.writeFileSync(path.join(dir, ".worktreeinclude"), ".env\n");
    assert.deepEqual(readOrcaConfig(dir), { setup: "echo hi", sharedDirectories: [] });
    assert.deepEqual(readWorktreeInclude(dir), [".env"]);

    fs.rmSync(path.join(dir, ".worktreeinclude"));
    fs.mkdirSync(path.join(dir, ".worktreeinclude"));
    assert.deepEqual(readWorktreeInclude(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
