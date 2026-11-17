const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { makeRepo } = require("./helpers/repo");

const CLI = path.resolve(__dirname, "../bin/orca-wt.js");

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

assertBoth("isShellArgv detects shells including login shells", (mod) => {
  const cases = [
    ["zsh", true],
    ["-zsh", true],
    ["/bin/bash", true],
    ["/opt/homebrew/bin/fish", true],
    ["sh", true],
    ["dash", true],
    ["ksh", true],
    ["tcsh", true],
    ["csh", true],
    ["nu", true],
    ["pwsh", true],
    ["elvish", true],
    ["codex", false],
    ["/usr/local/bin/claude", false],
    ["", false],
    [null, false],
    [undefined, false],
  ];
  return cases.map(([argv0, expected]) => {
    const actual = mod.isShellArgv(argv0);
    assert.equal(actual, expected, `isShellArgv(${String(argv0)})`);
    return actual;
  });
});

assertBoth("agentExited detects exit by missing foreground, shell argv, or pid change", (mod) => {
  const cases = [
    [{ foreground: { pid: 100, argv: ["codex"] } }, null, true],
    [{ foreground: { pid: 100, argv: ["codex"] } }, {}, true],
    [{ foreground: { pid: 100, argv: ["codex"] } }, { foreground: { pid: 100, argv: ["-zsh"] } }, true],
    [{ foreground: { pid: 100, argv: ["claude"] } }, { foreground: { pid: 101, argv: ["/bin/bash"] } }, true],
    [{ foreground: { pid: 100, argv: ["codex"] } }, { foreground: { pid: 100, argv: ["codex"] } }, false],
    [{ foreground: { pid: 100, argv: ["codex"] } }, { foreground: { pid: 200, argv: ["node"] } }, true],
    [null, { foreground: { pid: 100, argv: ["codex"] } }, false],
  ];
  return cases.map(([before, after, expected], i) => {
    const actual = mod.agentExited(before, after);
    assert.equal(actual, expected, `agentExited case ${i}`);
    return actual;
  });
});

function makeRecord(overrides = {}) {
  return {
    version: 1,
    sleptAt: 1794890000000,
    branch: "b1",
    agents: [
      {
        terminal: "t1",
        tab: "tb1",
        name: "Codex",
        kind: "codex",
        cwd: "/tmp/wt",
        resume: "codex resume 019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f",
        flags: ["--no-daemon"],
        command: "codex --no-daemon resume 019a7c2b-4d8e-7f10-8a3c-9e1b2c3d4e5f",
      },
    ],
    ...overrides,
  };
}

function runCli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("saveSleep, getSleep, clearSleep on linked worktree and main checkout", (t) => {
  const sleep = require("../src/sleep");
  const repo = makeRepo();
  t.after(() => repo.cleanup());

  const wtGitDir = spawnSync("git", ["-C", repo.worktree, "rev-parse", "--path-format=absolute", "--git-dir"], {
    encoding: "utf8",
  }).stdout.trim();
  const wtSleepFile = path.join(fs.realpathSync(wtGitDir), "orca-sleep.json");

  const rec1 = makeRecord({ branch: "b1" });
  const save1 = sleep.saveSleep(repo.worktree, rec1);
  assert.ok(!save1.error, save1.error);
  assert.equal(fs.existsSync(wtSleepFile), true);
  assert.deepEqual(sleep.getSleep(repo.worktree), rec1);

  sleep.clearSleep(repo.worktree);
  assert.equal(fs.existsSync(wtSleepFile), false);
  assert.equal(sleep.getSleep(repo.worktree), null);

  // Main checkout stores in .git/orca-sleep.json
  const mainSleepFile = path.join(repo.primary, ".git", "orca-sleep.json");
  const rec2 = makeRecord({ branch: "main" });
  const save2 = sleep.saveSleep(repo.primary, rec2);
  assert.ok(!save2.error, save2.error);
  assert.equal(fs.existsSync(mainSleepFile), true);
  assert.deepEqual(sleep.getSleep(repo.primary), rec2);
});

test("saveSleep rejects invalid resume and bad record shapes", (t) => {
  const sleep = require("../src/sleep");
  const repo = makeRepo();
  t.after(() => repo.cleanup());

  const badCases = [
    null,
    {},
    makeRecord({ version: 2 }),
    makeRecord({ sleptAt: "now" }),
    makeRecord({ agents: [] }),
    makeRecord({
      agents: [
        {
          terminal: "t1",
          tab: "tb1",
          name: "Codex",
          kind: "codex",
          cwd: "/tmp/wt",
          resume: "codex resume 123",
          flags: [],
          command: "codex resume 123",
        },
      ],
    }),
    makeRecord({
      agents: [
        {
          terminal: "t1",
          tab: "tb1",
          name: "Claude",
          kind: "claude",
          cwd: "/tmp/wt",
          resume: "claude --continue",
          flags: [],
          command: "claude --continue",
        },
      ],
    }),
  ];

  for (const bad of badCases) {
    const res = sleep.saveSleep(repo.worktree, bad);
    assert.ok(res && res.error, `expected error for ${JSON.stringify(bad)}`);
  }

  assert.equal(sleep.getSleep(repo.worktree), null);
});

test("listSleep returns sleeping worktrees with repo and skips non-sleeping worktrees", (t) => {
  const sleep = require("../src/sleep");
  const repo = makeRepo();
  t.after(() => repo.cleanup());

  // Add a third worktree that will NOT have a sleep record
  const wt2Raw = path.join(path.dirname(repo.primary), "wt-awake");
  const add = spawnSync("git", ["-C", repo.primary, "worktree", "add", "-b", "b2", wt2Raw], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);

  const recMain = makeRecord({ branch: "main", sleptAt: 1000 });
  const recWt = makeRecord({ branch: "b1", sleptAt: 2000 });
  assert.ok(!sleep.saveSleep(repo.primary, recMain).error);
  assert.ok(!sleep.saveSleep(repo.worktree, recWt).error);

  const listed = sleep.listSleep([repo.primary, "/nonexistent/repo/path"]);
  assert.deepEqual(Object.keys(listed).sort(), [repo.primary, repo.worktree].sort());
  assert.deepEqual(listed[repo.primary], { ...recMain, repo: repo.primary });
  assert.deepEqual(listed[repo.worktree], { ...recWt, repo: repo.primary });

  // CLI sleep list matches
  const cliListed = runCli(["sleep", "list", repo.primary]);
  assert.deepEqual(cliListed, listed);
});

test("codexSession finds newest matching rollout file after sinceMs", (t) => {
  const sleep = require("../src/sleep");
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-codex-sess-")));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const targetCwd = "/tmp/my-worktree";
  const sinceMs = Date.parse("2026-11-17T10:00:00.000Z");

  const subDir = path.join(tmpDir, "2026", "11", "17");
  fs.mkdirSync(subDir, { recursive: true });

  // 1. Other cwd (after sinceMs)
  fs.writeFileSync(
    path.join(subDir, "rollout-2026-11-17T10-05-00-other.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019a0000-0000-7000-8000-000000000001", timestamp: "2026-11-17T10:05:00.000Z", cwd: "/tmp/other" },
    }) + "\n"
  );

  // 2. Same cwd, before sinceMs
  fs.writeFileSync(
    path.join(subDir, "rollout-2026-11-17T09-55-00-old.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019a0000-0000-7000-8000-000000000002", timestamp: "2026-11-17T09:55:00.000Z", cwd: targetCwd },
    }) + "\n"
  );

  // 3. Same cwd, after sinceMs
  fs.writeFileSync(
    path.join(subDir, "rollout-2026-11-17T10-02-00-match.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "019a0000-0000-7000-8000-000000000003", timestamp: "2026-11-17T10:02:00.000Z", cwd: targetCwd },
    }) + "\n" + "{\"type\":\"other\"}\n"
  );

  assert.deepEqual(sleep.codexSession(targetCwd, sinceMs, tmpDir), {
    id: "019a0000-0000-7000-8000-000000000003",
  });

  // None matching
  assert.deepEqual(sleep.codexSession("/tmp/no-match", sinceMs, tmpDir), { id: null });
  // Missing sessions dir
  assert.deepEqual(sleep.codexSession(targetCwd, sinceMs, path.join(tmpDir, "missing")), { id: null });
});

test("CLI sleep save, get, clear and codex-session", (t) => {
  const repo = makeRepo();
  t.after(() => repo.cleanup());

  assert.deepEqual(runCli(["sleep", "get", repo.worktree]), { sleeping: false });

  const rec = makeRecord();
  const saved = runCli(["sleep", "save", repo.worktree, JSON.stringify(rec)]);
  assert.ok(!saved.error, saved.error);

  assert.deepEqual(runCli(["sleep", "get", repo.worktree]), rec);

  const cleared = runCli(["sleep", "clear", repo.worktree]);
  assert.ok(!cleared.error, cleared.error);
  assert.deepEqual(runCli(["sleep", "get", repo.worktree]), { sleeping: false });

  const cs = runCli(["codex-session", "/tmp/nonexistent-cwd-for-orca-test", String(Date.now())]);
  assert.deepEqual(cs, { id: null });
});

assertBoth("fullAccessFlags returns the missing full-access flag per agent", (mod) => {
  assert.deepEqual(mod.fullAccessFlags("claude", ["claude"]), ["--dangerously-skip-permissions"]);
  assert.deepEqual(mod.fullAccessFlags("codex", ["codex", "--no-daemon"]), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(mod.fullAccessFlags("agy", []), ["--dangerously-skip-permissions"]);
  assert.deepEqual(mod.fullAccessFlags("claude", ["--dangerously-skip-permissions"]), []);
  assert.deepEqual(mod.fullAccessFlags("dsh", []), []);
  assert.deepEqual(mod.fullAccessFlags(null, []), []);
  const kept = mod.keptFlags("codex", ["codex", "--no-daemon"]);
  const cmd = mod.withFlags("codex", "codex resume abc", [...kept, ...mod.fullAccessFlags("codex", kept)]);
  assert.equal(cmd, "codex --no-daemon --dangerously-bypass-approvals-and-sandbox resume abc");
  return cmd;
});

assertBoth("atPrompt accepts idle and done hc states only", (mod) => {
  const r = ["idle", "done", "working", "blocked", undefined, null].map((s) => mod.atPrompt(s));
  assert.deepEqual(r, [true, true, false, false, false, false]);
  return r;
});

assertBoth("quitArgv quits codex with ctrl+d and the rest with a typed command", (mod) => {
  const r = ["codex", "claude", "agy"].map((k) => mod.quitArgv(k, "t1"));
  assert.deepEqual(r, [
    ["keys", "--json", "t1", "ctrl+d"],
    ["send", "--json", "t1", "/exit"],
    ["send", "--json", "t1", "/quit"],
  ]);
  return r;
});
