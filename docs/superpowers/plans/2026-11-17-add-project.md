# Add Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A saved project list so repos wait in the projects sidebar (header + `+`, no spaces), added by choosing a local folder or cloning a Git URL, removable from a header right-click, seeded once from today's open repos.

**Architecture:** `src/projects.js` owns `projects.json` and `git clone` (Node, `node:test`), exposed as `orca-wt projects …` / `orca-wt clone`. `group()` learns saved-only groups. The `projects` sidebar loads the list, seeds it once, and runs all slow work (folder pick, clone) from requests that a new `orca-project` overlay mod sends through `setShared`, because overlays lose their tasks when they close.

**Tech Stack:** Node 24 (`node:fs`, `node:child_process`), `node:test`, Herdr.app mods (gpui-kit, gpui-base `InputState`/`Input`, `herdr`).

**Spec:** `docs/superpowers/specs/2026-11-17-add-project-design.md`

## Global Constraints

- List file `~/.local/state/orca-worktrees/projects.json` = `{ "version": 1, "projects": [{ "path" }] }`; directory overridable by env `ORCA_WT_STATE_DIR` (tests only). Atomic write (`.tmp` + rename). Invalid JSON: `list` → `{ error }`; any write first renames it to `projects.json.bad-<Date.now()>`.
- Paths stored = `fs.realpathSync(gitInfo(folder).primary)`, de-duplicated, order added.
- Clone: `git clone -- <url> <dest>` with env `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, timeout **590 000 ms**; error = last **20** stderr lines.
- `exec` from mods: `timeout: 600000` for clone; default otherwise.
- Shared keys: `orca.projects.rev` (number), `orca.projects.request` (`{ id, kind: "pick" }` or `{ id, kind: "clone", url, parent, name }`), `orca.projects.clone` (`{ id, state: "running"|"done"|"error", error? }`).
- Toasts: success `{ title: "Project added", body: <name> }`; failures `{ title: "Add project" | "Clone failed", body: error, level: "error" }`.
- Default clone parent: `localStorage` `clone.parent`, else `<home()>/jimmy_dev` if `exec("test", ["-d", …])` exits 0, else `home()`.
- Never delete/move anything on disk on remove; never edit shipped mods or `layouts/main.json`.
- `init()` returns early when `checking()`; overlay mods draw nothing without `props().overlay`.
- Commits: no AI co-author trailer.

## Review Focus

1. A clone of a private repo without access must fail within seconds, not wait for a prompt — test `clone fails fast without credentials` (Task 1) + manual check 6.
2. Esc during "Cloning…" must still add the project and toast — manual check 5 (the sidebar owns the work, Task 3 Step 3).
3. Choose folder must actually add (popup closes before the picker returns) — manual check 2 (Task 3 Step 3 `pick` request).
4. A hand-edited / corrupted `projects.json` must not be silently overwritten by a read — test `invalid json` (Task 1).
5. A request must be handled once even though `check()` runs every 500 ms and every mod re-renders on `setShared` — Task 3 Step 3 `handledRequest` + manual check 2 (exactly one header).

---

## Files

- Create: `src/projects.js`, `test/projects.test.js`, `mods/orca-project/main.js`, `mods/orca-project/mod.json`
- Modify: `bin/orca-wt.js` (argument parsing + new commands), `mods/projects/group.js` (`opts.saved`), `test/projects-group.test.js`, `mods/projects/main.js`, `scripts/install.sh:16`

### Task 1: `src/projects.js` + CLI

**Interfaces — Produces (`module.exports` of `src/projects.js`):**
- `stateDir() => string` — `process.env.ORCA_WT_STATE_DIR || ~/.local/state/orca-worktrees`.
- `listProjects() => { projects: {path, exists}[], seeded: boolean } | { error }`
- `addProject(folder) => { path, added: boolean } | { error: "Not a git repository" }`
- `removeProject(path) => { removed: boolean }` (compares realpath when it exists, else the raw string)
- `seedProjects(paths: string[]) => { seeded: boolean, projects: string[] }`
- `defaultCloneName(url) => string`
- `cloneProject(url, parent, name) => { path } | { error }`
- CLI (`bin/orca-wt.js`): `projects list`, `projects add <folder>`, `projects remove <path>`, `projects seed <path>...`, `clone <url> <parent> <name>`; positional args are everything after the command words that doesn't start with `--`.

- [ ] **Step 1: Failing tests** in `test/projects.test.js` (CommonJS; `beforeEach` sets `process.env.ORCA_WT_STATE_DIR` to a fresh `fs.mkdtempSync` dir and `makeRepo()` from `./helpers/repo`; `afterEach` cleans up and deletes the env var):
  - `list missing file`: `listProjects()` deep-equals `{ projects: [], seeded: false }`.
  - `add primary and worktree once`: `addProject(primary)` → `{ path: primary, added: true }`; `addProject(worktree)` → `{ path: primary, added: false }`; list has one entry `{ path: primary, exists: true }`, `seeded: true`.
  - `add non-git`: a plain temp dir → `{ error: "Not a git repository" }`.
  - `remove`: after add, `removeProject(primary)` → `{ removed: true }`, list empty; again → `{ removed: false }`.
  - `seed once`: `seedProjects([primary, nonGitDir])` → `seeded: true`, `projects` = `[primary]`; second call → `seeded: false`; `seedProjects` after a fresh state dir where `addProject` ran first → `seeded: false`.
  - `invalid json`: write `"{nope"` to `projects.json` → `listProjects().error` truthy, file unchanged; `addProject(primary)` succeeds and a `projects.json.bad-*` file exists with `{nope`.
  - `missing folder`: add, then `fs.rmSync` a copied repo dir → its entry `exists: false`.
  - `defaultCloneName`: `https://github.com/a/b.git`, `https://github.com/a/b/`, `git@github.com:a/b.git`, `ssh://git@host/a/b` → all `"b"`.
  - `clone local bare`: `git clone --bare <primary> <tmp>/src.git`; `cloneProject("file://" + bare, parentDir, "dst")` → `{ path: <parentDir>/dst }`, `<parentDir>/dst/.git` exists, list contains it.
  - `clone refuses`: existing dest → error contains `already exists`; names `"a/b"`, `".."`, `""` → error; parent not a directory → error.
  - `clone bad url`: `cloneProject("file:///no/such/repo.git", parentDir, "x")` → `error` truthy and `<parentDir>/x` doesn't exist.
  - `clone fails fast without credentials`: `cloneProject("https://github.com/this-org-does-not-exist-orca-wt/nope.git", parentDir, "y")` resolves with `error` in under 20 s (skip the test when `process.env.CI_OFFLINE` is set).
  - `cli projects list`: `spawnSync(process.execPath, ["bin/orca-wt.js", "projects", "list"], { env })` stdout parses to `{ projects: [], seeded: false }`.
- [ ] **Step 2:** `node --test test/projects.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement `src/projects.js` (use `gitInfo` from `./git-info`; `spawnSync("git", [...], { env: {...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes"}, timeout: 590000, encoding: "utf8" })`), then wire the CLI cases in `bin/orca-wt.js` without changing existing commands' behaviour.
- [ ] **Step 4:** `npm test` → all pass (old and new).
- [ ] **Step 5:** `git add src/projects.js bin/orca-wt.js test/projects.test.js && git commit -m "feat: saved project list and clone in orca-wt"`

### Task 2: `group()` with saved projects

**Interfaces — Produces:** `group(spaces, placeOf, repoOf, opts)` accepts `opts.saved: {path, exists}[]` (default `[]`). Saved paths with no group this round add `{ key: path, name: <basename>, kind: "repo", primary: path, primarySpace: null, rows: [], saved: true, exists }` after all space groups, in saved order, before `other`. A group with spaces whose key is saved gets `saved: true, exists: true`.

- [ ] **Step 1: Failing tests** in `test/projects-group.test.js`:
  - `saved-only group after space groups`: spaces in `/r`; saved `[{path:"/s",exists:true}]` → keys `["/r","/s"]`, `/s` has `rows: []`, `saved: true`.
  - `saved before Other`: plus a non-git space → keys `["/r","/s","other"]`.
  - `saved with spaces not duplicated`: saved `[{path:"/r",exists:true}]` → one `/r` group, `saved: true`.
  - `missing saved keeps header`: saved `[{path:"/gone",exists:false}]` → group `/gone` with `exists: false`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` → pass.
- [ ] **Step 5:** `git commit -am "feat: saved-only project groups"` (only `group.js` and its test staged).

### Task 3: Sidebar + `orca-project` mod

**Interfaces — Consumes:** Task 1 CLI, Task 2 `group` opts; `herdr`: `pickFolder`, `notify`, `shared`, `setShared`, `home`, `exec`, `openOverlay`, `closeOverlay`, `props`; `gpui-base`: `InputState`, `Input` (follow `~/.config/herdr-app/mods/worktree/main.js`).

- [ ] **Step 1: `projects` list state.** `init`: `this.saved = []`, `this.seeded = null`, `this.rev = null`, `this.handledRequest = shared("orca.projects.request")?.id ?? null` (ignore a request left from before start), `this.loadSaved(cx)`. `loadSaved(cx)` = `cx.spawn` → `cli(["projects","list"])` → `this.saved = r.projects ?? []`, `this.seeded = r.error ? true : r.seeded` (an unreadable file is never re-seeded) → `cx.notify()` after the await.
- [ ] **Step 2: `check()` additions.** If `shared("orca.projects.rev") !== this.rev` → store it, `loadSaved`. Once `this.seeded === false` and the 3 s loading window is over and no probe is in flight → set `this.seeded = true` (guard) and `cx.spawn` `cli(["projects","seed", ...repo group primaries in current group order])` then bump `orca.projects.rev`.
- [ ] **Step 3: Requests.** In `check()`: `const q = shared("orca.projects.request")`; if `q?.id` and `q.id !== this.handledRequest` → `this.handledRequest = q.id` and `cx.spawn`:
  - `pick`: `const f = await pickFolder({ prompt: "Add project" })`; null → stop; `r = cli(["projects","add",f])`; error → toast "Add project"; else toast "Project added" with the basename and bump rev.
  - `clone`: `setShared("orca.projects.clone", { id, state: "running" })`; `r = cli(["clone", url, parent, name], 600000)`; error → `{ id, state: "error", error }` + toast "Clone failed"; else `{ id, state: "done" }`, toast "Project added" (`name`), bump rev.
- [ ] **Step 4: Render.** Pass `saved: this.saved` to `group()`. Headers with `exists === false`: name in `dim` + ` missing`, no `+`. Header `on_mouse_down("right")` on repo groups → `openOverlay({ mod: "orca-project", kind: "popup", width: 220, height: 80, props: { mode: "header", path: g.primary, saved: Boolean(g.saved) } })`. Below the scroll list (outside it), a 28 px row `+ Add project` (`muted`, hover `hover`) → `openOverlay({ mod: "orca-project", kind: "popup", width: 220, height: 90, props: { mode: "add" } })`. The "No spaces" early return (main.js ~line 192) only applies when there are no groups at all; the Add project row always shows (also under "Loading…").
- [ ] **Step 5: `mods/orca-project/mod.json`** = `{ "place": "none", "title": "Project" }`.
- [ ] **Step 6: `orca-project/main.js`.** Draws nothing without `props().overlay`.
  - `add`: rows **Choose folder…** (`setShared("orca.projects.request", { id: Date.now(), kind: "pick" })`, `closeOverlay`) and **Clone from URL…** (`closeOverlay`, then `openOverlay({ mod: "orca-project", kind: "dialog", width: 520, height: 230, props: { mode: "clone" } })`). Styled like `orca-new` rows.
  - `clone`: inputs Git URL (focused), Parent folder + **Choose…** button (`pickFolder` awaited here is fine: it only fills the field while the dialog is open), Folder name (auto from `defaultCloneName`-equivalent JS until edited — copy the 4-line function, mods can't `require`). **Clone**/Enter: validate non-empty URL and name; save `localStorage` `clone.parent` (try/catch); `this.reqId = Date.now()`; send the clone request. While `shared("orca.projects.clone")?.id === this.reqId`: `running` → inputs disabled, button "Cloning…"; `error` → error text in `t.blocked`, inputs enabled; `done` → `closeOverlay`. **Cancel**/Esc closes.
  - `header`: if `props().saved` → row **Remove from sidebar**: `exec(node, [cli, "projects", "remove", path])`, bump `orca.projects.rev`, close (awaited before close — it's fast); else a dim line "Not saved — it shows while its spaces are open".
- [ ] **Step 7: Install.** `scripts/install.sh:16` → `MODS=(orca-setup orca-remove projects orca-new orca-project)`.
- [ ] **Step 8: Check.** `bash scripts/install.sh && herdr-app check ~/.config/herdr-app/mods/orca-project && herdr-app check ~/.config/herdr-app/mods/projects && npm test` → pass.
- [ ] **Step 9:** `git add mods/projects mods/orca-project scripts/install.sh && git commit -m "feat: add project from folder or git clone"`

### Task 4: Verify in Herdr.app

- [ ] **Manual checks** (orca layout; each observed):
  1. First start after install: `~/.local/state/orca-worktrees/projects.json` now lists the repos you had open; close every space of `mottanrung-mono` → its header stays with `0` and `+`.
  2. `+ Add project` → Choose folder… → pick `~/jimmy_dev/orca` → exactly one `orca` header appears; its `+` → agent picker → a worktree is created under it.
  3. Choose a non-git folder (e.g. `~/Downloads`) → "Add project" error toast, no header.
  4. Clone from URL… → `https://github.com/octocat/Hello-World.git`, parent `~/jimmy_dev` → name fills as `Hello-World`; Clone → "Cloning…" → dialog closes, toast, header appears, folder exists.
  5. Clone another small repo and press Esc during "Cloning…" → toast and header still arrive.
  6. Clone `https://github.com/this-org-does-not-exist-orca-wt/nope.git` → error in the dialog within seconds (no hang).
  7. Clone into a name that already exists → "already exists" in the dialog.
  8. Right-click `Hello-World` header → Remove from sidebar → header gone; `~/jimmy_dev/Hello-World` still on disk (delete it by hand afterwards).
  9. Delete a saved test repo's folder → its header shows dimmed "missing" with no `+`; Remove from sidebar works.
