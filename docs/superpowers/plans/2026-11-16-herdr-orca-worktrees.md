# herdr-orca-worktrees (Herdr.app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Herdr.app mods plus a Node helper CLI that apply `orca.yaml` / `.worktreeinclude` to newly created worktree spaces and remove worktrees safely after `scripts.archive`.

**Architecture:** All git and file logic lives in a CommonJS Node CLI (`bin/orca-wt.js`) built from small pure-ish modules and tested with `node:test`. Two thin gpui-kit mods (`orca-setup`, a 28 px status strip docked by its own `mod.json` that watches for new worktree spaces and shows a Remove button; `orca-remove`, a dialog opened with `mod.open`) call the CLI through `exec` and act on its JSON output. `scripts/install.sh` only places the two mod folders and their `config.js`.

**Tech Stack:** Node ≥ 18 (24 via nvm), `node:test`, npm dep `yaml@^2.9.1` (helper only), git CLI, Herdr.app 0.1.16 mods (gpui-kit JS, `herdr` module), `herdr-app check`.

**Spec:** `docs/superpowers/specs/2026-11-16-herdr-orca-worktrees-design.md`

## Global Constraints

- Target is **Herdr.app** (`~/.config/herdr-app`, `herdr-app`, `hc`). Never touch the `herdr` TUI or `~/.config/herdr`.
- **Never edit shipped Herdr files**: no changes to `layouts/*.json`, `keys.json`, `settings.json` or shipped mods (edited layouts get moved to `<name>-edited` on restart; any `keys.json` edit freezes default shortcuts). Only `mods/orca-setup` and `mods/orca-remove` are written.
- Repo: `~/jimmy_dev/herdr-orca-worktrees` (own git repo). Mods: `orca-setup`, `orca-remove`.
- Mods: no Node APIs, no npm imports, no `setTimeout`; `init()` returns early when `checking()`; `herdr-app check <mod folder>` must pass. App API truth: `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts`, `gpui-kit.d.ts`.
- Every CLI command prints exactly one JSON object to stdout and exits 0; failures are `{"error": "<message>"}`.
- No trust prompt. Never overwrite a worktree path. Delete only symlinks whose real path is inside the primary checkout, with `unlink`. `--force` only after the Force remove click.
- Limits (from Orca): file 262,144 bytes; string field 65,536 bytes; `maxAliasCount: 100`; first 100 `sharedDirectories`; `.worktreeinclude` ≤ 262,144 bytes and ≤ 1,000 candidates; freshness window 10 minutes; archive output last 200 lines; `exec` timeout for `setup`/`archive`/`remove` 600000 ms.
- Runner env: `ORCA_ROOT_PATH`, `ORCA_WORKTREE_PATH`, `ORCA_WORKSPACE_NAME` (worktree basename), `CONDUCTOR_ROOT_PATH`, `GHOSTX_ROOT_PATH`. Runner dir `~/.local/state/orca-worktrees/runs/`. Done marker `<git-dir>/orca-setup-done`.
- Commits: no AI-attribution trailer.

## Review Focus

1. **Worktree path with spaces** (Herdr names checkouts `<dir>/<repo>/<branch>`): links, copies, runner `cd`, and `tab.new` argv must work. → Task 2, Task 3 tests.
2. **Shared path already a real directory** (agent ran `pnpm install` first): skipped, never replaced, never deleted by remove. → Task 2, Task 4 tests.
3. **Opening an existing / old worktree** (e.g. the 12 `~/orca/workspaces` spaces or Open worktree): no setup. → Task 3 freshness tests; Task 5 first-render rule.
4. **Two mod copies or a reload** racing on the same new space: setup runs once. → Task 3 marker test.
5. **`node` not on the mods' `exec` PATH** (nvm): mods use the absolute path from `config.js`. → Task 5 install step check.

---

### Task 1: Scaffold + `src/orca-config.js`

**Files:** Create `package.json` (`"scripts": {"test": "node --test"}`), `package-lock.json`, `.gitignore` (`node_modules/`, `mods/*/config.js`), `src/orca-config.js`, `test/orca-config.test.js`.

**Interfaces — Produces:**
- `normalizeRelPath(p: string): string | null`
- `parseOrcaYaml(text: string): { setup?: string, archive?: string, sharedDirectories: string[] } | null` (`null` = file rejected)
- `parseWorktreeInclude(text: string): string[]`
- `readOrcaConfig(dir: string): ReturnType<parseOrcaYaml> | null` (missing or rejected → `null`)
- `readWorktreeInclude(dir: string): string[]` (missing / not regular / too big → `[]`)

- [ ] **Step 1:** `git init`, `npm init -y`, `npm i yaml@^2.9.1`, write `.gitignore`.
- [ ] **Step 2: Failing tests**

```js
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
```

- [ ] **Step 3:** `npm test` → FAIL (module missing).
- [ ] **Step 4: Implement.** `YAML.parseDocument(text, { uniqueKeys: true, maxAliasCount: 100 })`; reject on `doc.errors.length`, non-map root, or `Buffer.byteLength > 262144`. Slice `sharedDirectories` to 100 before normalizing; dedupe preserving order. Include list capped at 1,000 valid entries.
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit `feat: orca.yaml and .worktreeinclude parsing`.

---

### Task 2: `src/fs-ops.js` + test repo helper

**Files:** Create `src/fs-ops.js`, `test/helpers/repo.js`, `test/fs-ops.test.js`.

**Interfaces — Produces:**
- `makeRepo({ gitignore, files?, dirs? }): { primary, worktree, cleanup() }` — temp dir whose name contains a space, **returned as `fs.realpathSync` paths** (macOS `/var` → `/private/var`, matching what git prints); `git init` with `-c user.name=t -c user.email=t@t`, commit `.gitignore` + `files`, create untracked `dirs` in primary, `git worktree add -b b1 "<tmp>/wt dir"`.
- `isIgnored(repo: string, rel: string): boolean`
- `linkShared(primary, worktree, dirs: string[]): { linked: string[], skipped: { path: string, reason: string }[] }`
- `copyIncludes(primary, worktree, paths: string[]): { copied: string[], skipped: { path, reason }[] }`
- `findOurSymlinks(primary, worktree, dirs: string[]): string[]` (absolute)
- Skip reasons exactly: `"missing"`, `"not a directory"`, `"not ignored"`, `"exists"`, `"copy failed"`.

- [ ] **Step 1: Failing tests** — a fresh repo per test (`beforeEach` → `makeRepo`, `afterEach` → `cleanup`) with `.gitignore` `node_modules/\n.cache/\n.env\nlink-env\n`, tracked `tracked/a`, dirs `node_modules`, `.cache`, plus `.env` and symlink `link-env -> .env` in primary. Symlink targets are `path.join(primary, rel)` exactly:

```js
test("links ignored dirs, skips the rest", () => {
  const r = linkShared(primary, worktree, ["node_modules", "tracked", "nope", ".env"]);
  assert.deepEqual(r.linked, ["node_modules"]);
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules")), path.join(primary, "node_modules"));
  assert.deepEqual(r.skipped.map(s => s.reason), ["not ignored", "missing", "not a directory"]);
});
test("never replaces an existing real directory", () => {
  fs.mkdirSync(path.join(worktree, ".cache")); fs.writeFileSync(path.join(worktree, ".cache/keep"), "1");
  assert.deepEqual(linkShared(primary, worktree, [".cache"]).skipped, [{ path: ".cache", reason: "exists" }]);
  assert.ok(fs.existsSync(path.join(worktree, ".cache/keep")));
});
test("copy follows top-level symlink, skips existing", () => {
  assert.deepEqual(copyIncludes(primary, worktree, [".env", "link-env"]).copied, [".env", "link-env"]);
  assert.equal(fs.lstatSync(path.join(worktree, "link-env")).isSymbolicLink(), false);
  assert.deepEqual(copyIncludes(primary, worktree, [".env"]).skipped, [{ path: ".env", reason: "exists" }]);
});
test("findOurSymlinks ignores real dirs", () => {
  linkShared(primary, worktree, ["node_modules"]); fs.mkdirSync(path.join(worktree, ".cache"));
  assert.deepEqual(findOurSymlinks(primary, worktree, ["node_modules", ".cache"]), [path.join(worktree, "node_modules")]);
});
test("findOurSymlinks: dangling and out-of-primary links are not ours", () => {
  fs.symlinkSync("/nonexistent/x", path.join(worktree, "node_modules"));
  fs.symlinkSync(os.tmpdir(), path.join(worktree, ".cache"));
  assert.deepEqual(findOurSymlinks(primary, worktree, ["node_modules", ".cache"]), []);
});
```

- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement.** Destination check with `fs.lstatSync` (dangling link = `"exists"`). Copy via `spawnSync("cp", ["-cRH", src, dest])` on darwin, fallback/linux `["-RH", ...]`, after `mkdirSync(dirname(dest), {recursive:true})`. `findOurSymlinks`: is symlink AND `realpathSync(link)` starts with `realpathSync(primary) + path.sep`. Add `// shortcut: no Orca copy budget (2 GiB / 50k entries), add one if worktree creation gets slow`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: shared directory links and include copies`.

---

### Task 3: `src/runner.js` + git info + freshness

**Files:** Create `src/runner.js`, `src/git-info.js`, `test/runner.test.js`, `test/git-info.test.js`.

**Interfaces — Produces:**
- `orcaEnv(primary: string, worktree: string): Record<string,string>`
- `buildRunner({ script, primary, worktree }): string`
- `writeRunner(text: string, name: string, dir = ~/.local/state/orca-worktrees/runs): string` (path, mode 0o700)
- `gitInfo(folder: string): { worktree: string, primary: string, gitDir: string, linked: boolean } | null` (null if not a git checkout)
- `claimFresh(gitDir: string, now = Date.now(), windowMs = 600000): boolean` — true only if admin dir age (`birthtimeMs || ctimeMs`) < window AND `orca-setup-done` absent; on true, creates `orca-setup-done` with `fs.openSync(p, "wx")` (exclusive; `EEXIST` → false).

- [ ] **Step 1: Failing tests**

```js
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
// fresh makeRepo per test (beforeEach/afterEach)
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
```

- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement.** Quote with `'` → `'\''`. Shebang replay: first line matching `^#!\S*(?:bash|sh)\s+(-\w+)` → `set <flags>` after `set -e`, line dropped. `gitInfo` uses `git -C folder rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir`; `primary = dirname(commonDir)`; compare with `realpathSync`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: runner script and worktree freshness`.

---

### Task 4: `bin/orca-wt.js` CLI

**Files:** Create `bin/orca-wt.js` (`#!/usr/bin/env node`, executable), `src/commands.js`, `test/cli.test.js`.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (stdout JSON, exit 0):
  - `info <folder>` → `{ worktree, primary, linked }`
  - `setup <worktree>` → `{ fresh: false }` or `{ fresh: true, linked, copied, skipped, runner: string|null }`; `{ error }` if not linked.
  - `preflight <worktree>` → `{ ours: string[], dirty: string[], archive: boolean, branch: string }`
  - `archive <worktree>` → `{ code: number, output: string }` (`code: 0, output: ""` when no archive script)
  - `remove <worktree> [--force]` → `{ ok: true }` or `{ ok: false, error }`
- `src/commands.js` exports one function per command returning the object; `bin/orca-wt.js` only parses argv, calls it, prints `JSON.stringify`, catches → `{ error: e.message }`.

- [ ] **Step 1: Failing tests** (spawn `node bin/orca-wt.js` with `HOME` set to a temp dir so runners land there; repo from `makeRepo` with primary `orca.yaml` `scripts: {setup: "echo setup-ran", archive: "echo archived"}, worktree: {sharedDirectories: [node_modules, .cache]}`, committed so the worktree has it, and `.worktreeinclude` `.env`):
  - `setup` → `fresh: true`, `linked` `["node_modules"]`, `copied` `[".env"]`, `runner` exists and contains `echo setup-ran`; second `setup` → `{ fresh: false }`.
  - `setup` when worktree's `orca.yaml` lacks `scripts.setup` (commit it in primary *after* `worktree add`) → `runner: null`, links still applied.
  - `preflight` with only our symlink untracked → `dirty: []`, `ours` = `[<wt>/node_modules]`; after writing `scratch.txt` → `dirty` = `["?? scratch.txt"]`.
  - `archive` → `{ code: 0, output: "archived\n" }`; with `archive: "exit 3"` → `code: 3`.
  - `remove` with `scratch.txt` present → `{ ok: false, error: "uncommitted changes" }` and the `node_modules` symlink still exists; `remove --force` → `ok: true`, worktree dir gone, `node_modules` in primary intact, branch `b1` still listed by `git branch`.
  - real dir `.cache` in worktree + `remove --force` → primary `.cache` untouched.
  - `preflight`, `archive`, `remove` and `remove --force` on the **primary** folder → each `{ error: "not a linked worktree" }`; a symlink placed in the primary beforehand still exists and the archive script did not run (it writes a marker file; assert absent).
  - `info /tmp` → `{ error }`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3: Implement.** `setup`, `preflight`, `archive`, `remove` first call `gitInfo` and return `{ error: "not a linked worktree" }` unless `linked`. `archive`: script = `readOrcaConfig(primary).archive`, run `spawnSync("bash", ["-e", "-c", script], { cwd: worktree, env: { ...process.env, ...orcaEnv(primary, worktree) }, timeout: 590000 })`. `remove` without `--force`: run `git status --porcelain --untracked-files=all` minus ours first; if dirty → `{ ok: false, error: "uncommitted changes" }` *without* unlinking; else unlink ours and `git -C primary worktree remove <wt>`. With `--force`: unlink ours, `worktree remove --force`. Archive output: last 200 lines of combined stdout+stderr. `branch` from `git -C wt branch --show-current`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: orca-wt CLI`.

---

### Task 5: `orca-setup` strip mod + `scripts/install.sh`

**Files:** Create `mods/orca-setup/main.js`, `mods/orca-setup/mod.json` (`{ "place": "bottom", "size": 28, "title": "Orca" }`), `scripts/install.sh`.
Modify (by install.sh): `~/.config/herdr-app/mods/orca-setup` only.

**Interfaces:**
- Consumes: CLI `info`, `setup` (Task 4); `herdr`: `spaces`, `machines`, `focused`, `exec`, `run`, `openOverlay`, `notify`, `theme`, `checking`.
- Produces: `mods/<mod>/config.js` → `export default { node: "<abs node>", cli: "<abs repo>/bin/orca-wt.js" };` (written by install.sh, read by both mods).

- [ ] **Step 1: Write `install.sh`** (bash, `set -euo pipefail`, idempotent, takes mod names as args, default both): resolve `node` with `command -v node` → abs path; for each mod: `ln -sfn "$REPO/mods/$m" ~/.config/herdr-app/mods/$m` (if Step 4 shows symlinks aren't followed, switch to `rsync -a --delete`); write its `config.js`. Writes nothing else under `~/.config/herdr-app`.
- [ ] **Step 2: Write `main.js`.** `export default class OrcaSetup extends View`.
  - `init(_p, cx)`: `if (checking()) return;` `this.seen = null; this.linked = {}; this.status = ""; this.error = false;` `cx.timer.every(3000, cx => this.scan(cx))`; `this.scan(cx)`.
  - `scan(cx)`: do nothing until `machines().find(m => m.name === null)?.layout === "ready"` (before that `spaces()` may be empty). `local = spaces().filter(s => s.machine === null && s.folder)`; first ready call → `this.seen = new Set(ids)` and queue `info` for each (to fill `this.linked`), no setup; later calls → for each id not in `seen`: add, `cx.spawn(async cx => this.handle(space, cx))`. Also call `scan` at the top of `render` (cheap: id compare only).
  - `handle(space, cx)`: status `setting up <basename>…`; `info` → cache `this.linked[id] = {folder, linked, worktree}`; if linked → `setup` (timeout 600000); `fresh:false` → clear status; `runner` → `run("tab.new", { space: id, name: "Setup", folder: worktree, argv: ["bash", runner], focus: false })`; status `<basename>: <n> linked, <m> copied` (+ `, <k> skipped` if any) and, when anything was linked, copied or a runner was started, `notify({ title: "Orca setup", body: <same text> })`; on `error` or exec reject → status = message, `this.error = true`, `notify({ title: "Orca setup", body, level: "error" })`; `cx.notify()`.
  - `render`: one `h_flex` row, height full, `px(10)`, `text_size(12)`, `bg(theme().chrome)`: `orca` (dim) · status (muted, or `theme().blocked` when error, `.truncate()`) · spacer · if `this.linked[focused()?.space]?.linked` (`focused().space` is the id **string**) a small button **Remove** → `openOverlay({ mod: "orca-remove", kind: "dialog", width: 560, props: { space: focused().space } })` (same pattern as `mods/worktree/main.js`). Re-query `info` when the focused space's `folder` (`spaces().find(s => s.id === focused()?.space)`) differs from the cached one.
- [ ] **Step 3:** `bash scripts/install.sh orca-setup`, then `herdr-app check ~/.config/herdr-app/mods/orca-setup` → exit 0.
- [ ] **Step 4:** `herdr-app status` → no errors and the strip is docked (`herdr-app shot` to look); confirm it loaded through the symlink (else switch install.sh to copy and rerun). Confirm `git -C ~/.config/herdr-app status` is not applicable / `ls ~/.config/herdr-app/layouts` shows no new `*-edited` file.
- [ ] **Step 5:** Commit `feat: orca-setup strip and installer`.

---

### Task 6: `orca-remove` dialog mod

**Files:** Create `mods/orca-remove/main.js`, `mods/orca-remove/mod.json` (`{ "place": "none", "title": "Remove worktree (Orca)", "overlay": { "kind": "dialog", "width": 560 } }`). Opened only by the strip's Remove button (Task 5).

**Interfaces — Consumes:** CLI `info`, `preflight`, `archive`, `remove`; `props().space` (id string, from Task 5's button) and `props().overlay`; `herdr`: `spaces`, `exec`, `run`, `closeOverlay`, `props`, `theme`, `checking`.

- [ ] **Step 1: Write `main.js`.** `init`: `if (checking()) return;` first. Target space = `spaces().find(s => s.id === props().space)` (missing → `error` state "space is gone"). Build it as a state machine with states `loading | not-worktree | confirm | archiving | archive-failed | removing | error`, rendered with `theme()` colours and gpui-base `Button`s (copy the look of `mods/worktree/main.js`). Flow exactly per spec: target space → `info` → `preflight` → Remove / Force remove (red, only when `dirty`) / Cancel → `archive` if present → on non-zero show output + Remove anyway / Cancel → `remove` (`--force` only after Force remove) → on `ok`: `run("space.close", { id, confirmed: true })` and `closeOverlay(props().overlay)`; else `error` state with message. Nothing calls `archive` or `remove` before the user clicks.
- [ ] **Step 2:** `bash scripts/install.sh`; `herdr-app check ~/.config/herdr-app/mods/orca-remove` → exit 0; `herdr-app status` → no errors.
- [ ] **Step 3:** In Herdr.app focus a non-worktree space: the strip shows no Remove button. (The dialog is only reachable from the button, so its live check happens in Task 7.)
- [ ] **Step 4:** Commit `feat: orca-remove dialog`.

---

### Task 7: Manual check in Herdr.app + README

**Files:** Create `README.md` (what it does, supported `orca.yaml` keys, install, the strip and its Remove button, non-goals incl. sleep, the known Orca-shared gotcha that a `node_modules/` gitignore pattern doesn't match the symlink so `git add -A` would commit it (use `node_modules` without the slash), uninstall: delete `~/.config/herdr-app/mods/orca-setup` and `orca-remove`).

- [ ] **Step 1:** Scratch repo `~/jimmy_dev/orca-wt-scratch` with committed `orca.yaml` (`setup: echo setup-ran`, `archive: echo archived`, `sharedDirectories: [node_modules]`), `.gitignore` (`node_modules/`, `.env`), `.worktreeinclude` (`.env`), and untracked `node_modules/`, `.env`. Open it as a space in Herdr.app.
- [ ] **Step 2:** Space menu → New worktree `try-1` → expect a toast, `node_modules` symlink, `.env` copy, and a Setup tab printing `setup-ran`. `herdr-app shot /tmp/orca-setup.png` for evidence.
- [ ] **Step 3:** Open worktree on an existing checkout → no toast, no Setup tab.
- [ ] **Step 4:** In `try-1` click the strip's **Remove** → dialog shows Remove (clean) → click → `archived` ran, checkout gone, space closed, `git branch` still lists `try-1`. Repeat with an untracked file → Force remove shown; Cancel leaves everything intact.
- [ ] **Step 4b:** Quit and relaunch Herdr.app → strip still docked; no `main-edited` toast; `ls ~/.config/herdr-app/layouts` unchanged.
- [ ] **Step 5:** Commit `docs: README`.
