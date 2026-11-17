const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "sleep");

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

async function loadImplementations() {
  const cjs = require("../src/sleep");
  const esm = await import(pathToFileURL(path.join(__dirname, "..", "mods", "projects", "sleep.js")).href);
  return { cjs, esm };
}

function assertBoth(label, fn) {
  test(label, async () => {
    const { cjs, esm } = await loadImplementations();
    const cjsResult = fn(cjs);
    const esmResult = fn(esm);
    assert.deepEqual(esmResult, cjsResult, "ESM and CJS implementations must return equal results");
  });
}

assertBoth("QUIT map matches spec", (mod) => {
  assert.deepEqual(mod.QUIT, {
    claude: "/exit",
    codex: "/quit",
    agy: "/quit",
    dsh: "/exit",
  });
  return mod.QUIT;
});

assertBoth("agentKind maps app and program.key", (mod) => {
  const cases = [
    [{ app: "claude-code" }, "claude"],
    [{ app: "claude" }, "claude"],
    [{ app: "codex" }, "codex"],
    [{ app: "agy" }, "agy"],
    [{ app: "antigravity" }, "agy"],
    [{ program: { key: "dsh-tui" } }, "dsh"],
    [{ app: "other", program: { key: "codex" } }, "codex"],
    [{ app: null, program: { key: "claude-code" } }, "claude"],
    [{ app: "unknown" }, null],
    [{}, null],
    [null, null],
    [undefined, null],
  ];
  return cases.map(([input, expected]) => {
    const actual = mod.agentKind(input);
    assert.equal(actual, expected);
    return actual;
  });
});

assertBoth("stripAnsi removes CSI and OSC sequences", (mod) => {
  const input = "\x1b[36mhello\x1b[0m \x1b]0;title\x07world\x1b]8;;https://example.com\x1b\\!\x1b[1;32m";
  const actual = mod.stripAnsi(input);
  assert.equal(actual, "hello world!");
  return actual;
});

assertBoth("parseResume real screens", (mod) => {
  const codex = mod.parseResume("codex", readFixture("codex-exit.txt"));
  assert.equal(codex, "codex resume 019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f");

  const agy = mod.parseResume("agy", readFixture("agy-exit.txt"));
  assert.equal(agy, "agy --conversation=b48e1f9a-2c3d-4e5f-8a9b-0c1d2e3f4a5b");

  const dsh = mod.parseResume("dsh", readFixture("dsh-exit.txt"));
  assert.equal(dsh, "DSH_TUI_RESUME_SESSION=a83addba-a0dc-45f1-be00-1654dd4ab9bd dsh --profile dsh-tui");

  const claude = mod.parseResume("claude", readFixture("claude-exit.txt"));
  assert.equal(claude, null);

  const claudeLong = mod.parseResume("claude", "Done.\n  claude --resume sess-123-abc \n");
  assert.equal(claudeLong, "claude --resume sess-123-abc");

  const claudeShort = mod.parseResume("claude", "claude -r sess456\n");
  assert.equal(claudeShort, "claude -r sess456");

  return { codex, agy, dsh, claude, claudeLong, claudeShort };
});

assertBoth("parseResume rejects near-miss", (mod) => {
  const screen = readFixture("near-miss.txt");
  const results = ["codex", "agy", "dsh", "claude", "unknown", null].map((kind) => {
    const actual = mod.parseResume(kind, screen);
    assert.equal(actual, null, `expected null for ${kind}`);
    return actual;
  });
  return results;
});

assertBoth("parseResume bottom-most match wins when two appear", (mod) => {
  const codex = mod.parseResume(
    "codex",
    "codex resume 11111111-1111-1111-1111-111111111111\nsome output\ncodex resume 22222222-2222-2222-2222-222222222222\n"
  );
  assert.equal(codex, "codex resume 22222222-2222-2222-2222-222222222222");

  const agy = mod.parseResume(
    "agy",
    "agy --conversation=first-1\nmore\nagy --conversation=second-2\n"
  );
  assert.equal(agy, "agy --conversation=second-2");

  const claude = mod.parseResume(
    "claude",
    "claude -r first1\nclaude --resume second2\n"
  );
  assert.equal(claude, "claude --resume second2");

  return { codex, agy, claude };
});

assertBoth("fallbackResume builds fallback commands per kind", (mod) => {
  const results = [
    [mod.fallbackResume("claude", { claudeSessionId: "sess-1" }), "claude --resume sess-1"],
    [mod.fallbackResume("claude", {}), null],
    [mod.fallbackResume("claude"), null],
    [mod.fallbackResume("codex", { codexSessionId: "019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f" }), "codex resume 019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f"],
    [mod.fallbackResume("codex", {}), null],
    [mod.fallbackResume("agy"), "agy --continue"],
    [mod.fallbackResume("dsh"), "dsh-tui --continue"],
    [mod.fallbackResume("other", { claudeSessionId: "x" }), null],
  ];
  for (const [actual, expected] of results) {
    assert.equal(actual, expected);
  }
  return results.map(([actual]) => actual);
});

assertBoth("keptFlags extracts launch flags and drops prompts", (mod) => {
  const c1 = mod.keptFlags("codex", ["codex", "--no-daemon", "fix tests"]);
  assert.deepEqual(c1, ["--no-daemon"]);

  const c2 = mod.keptFlags("claude", ["claude", "--model", "opus", "fix the bug"]);
  assert.deepEqual(c2, ["--model", "opus"]);

  const c3 = mod.keptFlags("claude", [
    "/usr/local/bin/claude",
    "--dangerously-skip-permissions",
    "--permission-mode=acceptEdits",
    "--effort",
    "high",
    "--unknown-flag",
    "val",
    "prompt",
  ]);
  assert.deepEqual(c3, ["--dangerously-skip-permissions", "--permission-mode=acceptEdits", "--effort", "high"]);

  const c4 = mod.keptFlags("agy", ["agy", "--mode", "agent", "--model=gemini", "--effort=medium", "do thing"]);
  assert.deepEqual(c4, ["--mode", "agent", "--model=gemini", "--effort=medium"]);

  const c5 = mod.keptFlags("dsh", ["dsh-tui", "--profile", "dsh-tui"]);
  assert.deepEqual(c5, []);

  const c6 = mod.keptFlags("claude", ["claude", "--model"]);
  assert.deepEqual(c6, []);

  return [c1, c2, c3, c4, c5, c6];
});

assertBoth("withFlags inserts flags after program word except dsh/env-prefixed", (mod) => {
  const w1 = mod.withFlags("codex", "codex resume X", ["--no-daemon"]);
  assert.equal(w1, "codex --no-daemon resume X");

  const w2 = mod.withFlags("claude", "claude --resume X", ["--model", "opus"]);
  assert.equal(w2, "claude --model opus --resume X");

  const w3 = mod.withFlags("dsh", "DSH_TUI_RESUME_SESSION=a dsh --profile dsh-tui", ["--model", "x"]);
  assert.equal(w3, "DSH_TUI_RESUME_SESSION=a dsh --profile dsh-tui");

  const w4 = mod.withFlags("codex", "codex resume X", []);
  assert.equal(w4, "codex resume X");

  return [w1, w2, w3, w4];
});

assertBoth("resumeArgv splits command and prefixes env when needed", (mod) => {
  const a1 = mod.resumeArgv("DSH_TUI_RESUME_SESSION=a dsh --profile dsh-tui");
  assert.deepEqual(a1, ["env", "DSH_TUI_RESUME_SESSION=a", "dsh", "--profile", "dsh-tui"]);

  const a2 = mod.resumeArgv("codex --no-daemon resume 019a7c2b");
  assert.deepEqual(a2, ["codex", "--no-daemon", "resume", "019a7c2b"]);

  const a3 = mod.resumeArgv("claude   --resume  abc");
  assert.deepEqual(a3, ["claude", "--resume", "abc"]);

  return [a1, a2, a3];
});

assertBoth("isValidResume accepts patterns and fallbacks, rejects invalid", (mod) => {
  const cases = [
    ["codex", "codex resume 019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f", true],
    ["codex", "codex resume 123", false],
    ["agy", "agy --conversation=b48e1f9a", true],
    ["agy", "agy --continue", true],
    ["agy", "agy --conversation=", false],
    ["dsh", "DSH_TUI_RESUME_SESSION=a83addba dsh --profile dsh-tui", true],
    ["dsh", "dsh-tui --continue", true],
    ["dsh", "dsh --continue", false],
    ["claude", "claude --resume abc123", true],
    ["claude", "claude -r abc123", true],
    ["claude", "claude --continue", false],
    ["unknown", "codex resume 019a7c2b", false],
    ["codex", "", false],
  ];
  return cases.map(([kind, cmd, expected]) => {
    const actual = mod.isValidResume(kind, cmd);
    assert.equal(actual, expected, `${kind}: ${cmd}`);
    return actual;
  });
});
