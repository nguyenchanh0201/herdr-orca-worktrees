# Projects Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Herdr.app mod `projects` that replaces the Spaces list in the person's `orca` layout with Orca-style groups: one header per git repo (collapse, count, `+` new worktree) and the repo's spaces as rows with an agent status dot.

**Architecture:** A pure, import-free `mods/projects/group.js` decides places and groups (unit-tested with `node --test`). `mods/projects/main.js` is a thin gpui-kit view: a 500 ms no-exec timer notices new spaces/places, probes each new place with the existing `orca-wt info` (max 6 in flight), caches the answer, and renders `group()`'s output. Installed by `scripts/install.sh`; shown by changing one `mod` name in `~/.config/herdr-app/layouts/orca.json`.

**Tech Stack:** Herdr.app mods (JavaScript on gpui-kit / gpui-base / `herdr` modules), Node 24 `node:test`, existing `bin/orca-wt.js`.

**Spec:** `docs/superpowers/specs/2026-11-16-projects-sidebar-design.md`

## Global Constraints

- Never edit shipped Herdr files (`layouts/main.json`, `mods/spaces`, …). Only `~/.config/herdr-app/layouts/orca.json` (the person's clone) changes.
- No `exec` in a polling loop; the 500 ms timer only compares ids/places. No animation timers.
- `init()` returns early when `checking()` is true; `herdr-app check mods/projects` must pass.
- Probes: `orca-wt info <place>` → `{ worktree, primary, linked }` or `{ error }`; at most **6** in flight.
- New space with unknown repo held back at most **1 s**, then shown in **Other**. First start: "Loading…" until the first probes are back, at most **3 s**.
- Header 28px, row 28px, rows indented 12px. Colours only from `theme()`.
- Collapsed group keys in `localStorage` key `projects.collapsed` (JSON array), every access in try/catch.
- `+` → `openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { folder: <primary>, machine: null, action: "new" } })`. No `+` on machine groups or Other.
- Right-click row → `openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id } } })`.
- `cx.notify()` after an `await`, never before it (commit 89647f5).
- Commits: no AI co-author trailer (person's global rule).

## Review Focus

1. A space whose terminal `cd`s into another repo must move to that repo's group (not stay in the old one) once the new place is probed — test in Task 1 (`moves when place changes`).
2. A probe that fails, times out or prints `{ error }` must cache `null` (Other), never stay "unknown" and hold the row forever — test in Task 1 (`unknown past giveUp goes to Other`) + Task 2 Step 3 rule.
3. Remote spaces (`machine !== null`) must never be probed locally (their paths don't exist here) — test in Task 1 (`remote grouped by machine`) + Task 2 probe filter.
4. A collapsed group that contains the active space still shows that one row — test in Task 1 (`visibleRows keeps active in collapsed group`).
5. A named space shows its name, an unnamed one its branch, a non-git one its name — test in Task 1 (`label`).

---

## File Structure

- Create `mods/package.json` — `{"type":"module"}` so Node loads mod files as ESM in tests (the root `package.json` says `commonjs`). Not copied by `install.sh`.
- Create `mods/projects/group.js` — pure: `placeOf`, `group`, `visibleRows`, `label`. No imports.
- Create `mods/projects/main.js` — the view: probes, cache, timer, render.
- Create `mods/projects/mod.json` — `{ "place": "none", "title": "Projects" }`.
- Create `test/projects-group.test.js` — tests for `group.js`.
- Modify `scripts/install.sh:16` — default mod list adds `projects`.
- Modify (outside repo, manual) `~/.config/herdr-app/layouts/orca.json` — block `"id": "spaces"`: `"mod": "spaces"` → `"mod": "projects"`.

---

### Task 1: Pure grouping (`group.js`)

**Files:**
- Create: `mods/package.json`, `mods/projects/group.js`
- Test: `test/projects-group.test.js`

**Interfaces:**
- Produces (all named exports of `mods/projects/group.js`):
  - `placeOf(space: SpaceInfo, panes: {tab: string, cwd: string|null}[]) => string` — first pane (in `panes` order) whose `tab` is one of `space.tabs[].id` and has a `cwd`; else `space.folder`.
  - `group(spaces: SpaceInfo[], placeOf: (s) => string, repoOf: (place) => ({primary: string, linked: boolean} | null | undefined), opts: { prevKeyOf: (id) => string|undefined, giveUp: (id) => boolean }) => Group[]`
    - `Group = { key: string, name: string, kind: "repo"|"machine"|"other", primary: string|null, primarySpace: string|null, rows: { space: SpaceInfo, main: boolean }[] }`
    - Keys: repo → its `primary` path; machine → `"machine:" + name`; other → `"other"`.
    - `repoOf` result: object = git, `null` = not git (→ Other), `undefined` = not probed yet → `prevKeyOf(id)` group if it names an existing group key this round, else Other if `giveUp(id)`, else the space is omitted.
    - Remote spaces (`machine !== null`) are never passed to `repoOf`.
    - Group order: by index of each group's first space in `spaces`; `other` always last. Rows: `main` (linked === false) first, then `spaces` order.
  - `visibleRows(g: Group, collapsed: boolean) => Row[]` — all rows, or only the active row(s) when collapsed.
  - `label(space: SpaceInfo) => string` — `named ? name : (branch ?? name)`.

- [ ] **Step 1: Create `mods/package.json`** containing exactly `{"type":"module"}`.

- [ ] **Step 2: Write the failing tests** in `test/projects-group.test.js` (CommonJS, like the other tests; load with `let g; test.before(async () => { g = await import("../mods/projects/group.js"); });`). Fixture helper `sp(id, { folder, machine = null, branch = null, named = false, name = id, active = false, tabs = [] })`. Tests and assertions:
  - `placeOf uses first pane cwd of its tabs`: space tabs `[{id:"t1"}]`, panes `[{tab:"x",cwd:"/a"},{tab:"t1",cwd:"/r/sub"}]` → `"/r/sub"`; no matching pane → `space.folder`.
  - `groups main and worktrees`: spaces `w1` (place `/wt/a`), `m` (`/r`), `w2` (`/wt/b`); repoOf `/r`→`{primary:"/r",linked:false}`, `/wt/*`→`{primary:"/r",linked:true}` → one group `{key:"/r", name:"r", kind:"repo", primary:"/r", primarySpace:"m"}`, rows ids `["m","w1","w2"]`, `rows[0].main === true`.
  - `header without main space`: only `w1`,`w2` → `primarySpace === null`, `primary === "/r"`.
  - `non-git goes to Other last`: `h` (repoOf → `null`) listed first, `/r` space second → groups keys `["/r","other"]`.
  - `remote grouped by machine`: space `machine:"vps"`; `repoOf` is a function that throws if called with its place → group `{key:"machine:vps", name:"vps", kind:"machine"}`.
  - `group order follows spaces()`: spaces from repo B then repo A → keys `["/b","/a"]`.
  - `unknown held, then prev group, then Other`: repoOf → `undefined`; with `prevKeyOf→undefined, giveUp→false` space absent from every group; with `prevKeyOf→"/r"` (and `/r` group present via another space) it is in `/r`; with `giveUp→true` it is in `other`.
  - `moves when place changes`: same space, place `/r` then `/s` (repoOf answers both) → first call in `/r`, second in `/s`, `/r` group gone.
  - `visibleRows keeps active in collapsed group`: rows `a`(active), `b` → collapsed → `["a"]`; expanded → `["a","b"]`.
  - `label`: `{named:true,name:"fix",branch:"b"}`→`"fix"`; `{named:false,name:"r",branch:"feat/x"}`→`"feat/x"`; `{named:false,name:"~",branch:null}`→`"~"`.

- [ ] **Step 3: Run to verify they fail**
  Run: `node --test test/projects-group.test.js`
  Expected: FAIL (cannot find module `mods/projects/group.js`).

- [ ] **Step 4: Implement `group.js`** with the four exports above. Name = last path segment of `primary`. Build groups in one pass over `spaces`, keeping a `Map` keyed by group key (insertion order = first-space order), then move `other` to the end and stable-sort each group's rows by `main` first.

- [ ] **Step 5: Run to verify they pass**
  Run: `node --test test/projects-group.test.js` → all pass. Then `npm test` → the whole suite still passes.

- [ ] **Step 6: Commit**
  ```bash
  git add mods/package.json mods/projects/group.js test/projects-group.test.js
  git commit -m "feat: projects sidebar grouping"
  ```

---

### Task 2: The `projects` mod view

**Files:**
- Create: `mods/projects/main.js`, `mods/projects/mod.json`
- Modify: `scripts/install.sh:16` (`MODS=(orca-setup orca-remove projects)`)

**Interfaces:**
- Consumes: `placeOf`, `group`, `visibleRows`, `label` from Task 1; `config.js` (`{ node, cli }`) written by `install.sh`; `herdr`: `spaces, panes, machines, run, openOverlay, exec, theme, checking`; `gpui-base`: `v_flex, h_flex, ScrollHandle`; `gpui-kit`: `View, div`.
- Produces: default-exported `class Projects extends View`.

- [ ] **Step 1: `mod.json`** = `{ "place": "none", "title": "Projects" }`.

- [ ] **Step 2: State in `init(_p, cx)`** (return first if `checking()`):
  `repo = new Map()` (place → `{primary, linked}` | `null`), `inflight = new Set()` of places, `queue = []` of places, `keyOf = new Map()` (space id → last group key), `seenAt = new Map()` (space id → first time its place was unknown, ms), `startedAt = Date.now()`, `collapsed = new Set(JSON.parse(localStorage.getItem("projects.collapsed") ?? "[]"))` in try/catch, `scroll = ScrollHandle.new()`, `lastActive = null`, `sig = ""`. Then `cx.timer.every(500, (cx) => this.check(cx))` and `this.check(cx)`.

- [ ] **Step 3: `check(cx)`** — no `exec` here.
  Skip if local machine layout isn't `"ready"` (same test as `orca-setup`'s `scan`). For each local space with a non-empty place not in `repo`, not in `inflight`, not in `queue`: push to `queue`, set `seenAt` if missing. Call `pump(cx)`. Compute `sig` = joined `id=place` of all spaces + active id; `cx.notify()` if it changed, or if any held space just passed 1 s, or the 3 s start window just ended.

- [ ] **Step 4: `pump(cx)`** — while `inflight.size < 6` and `queue` not empty: take a place, add to `inflight`, `cx.spawn(async (cx) => …)`:
  `exec(config.node, [config.cli, "info", place])`; parse stdout JSON; set `repo.set(place, r.error ? null : { primary: r.primary, linked: Boolean(r.linked) })`. On any throw / non-zero code / bad JSON: `repo.set(place, null)`. `finally`: delete from `inflight`, `pump(cx)`, then `cx.notify()` (after the await).

- [ ] **Step 5: `render()`** — no side effects except `keyOf` bookkeeping and scroll:
  - Local layout not ready, or `Date.now() - startedAt < 3000` while `inflight.size + queue.length > 0` → centred "Loading…" in `muted`.
  - Else `groups = group(spaces(), (s) => placeOf(s, ps), (p) => repo.get(p), { prevKeyOf: (id) => keyOf.get(id), giveUp: (id) => Date.now() - (seenAt.get(id) ?? 0) >= 1000 })`; then record each row's group key in `keyOf`.
  - No spaces → "No spaces" in `muted`.
  - Scrollable list as the shipped sidebar does it (`~/.config/herdr-app/mods/spaces/main.js:538-548`): `v_flex().flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)`, headers and rows as its **direct** children. Track the active row's index among those children; when the active space id differs from `lastActive`, call `this.scroll.scroll_to_item(index)` and update `lastActive`.
  - Header (h 28): chevron `▾`/`▸`, name (`foreground`, bold), row count (`muted`), spacer, and for `kind === "repo"` a `+` button that stops propagation and runs the `+` overlay from Global Constraints with `folder: g.primary`. Header click toggles `g.key` in `collapsed`, saves `localStorage.setItem("projects.collapsed", JSON.stringify([...collapsed]))` in try/catch, `cx.notify()`.
  - Rows from `visibleRows(g, collapsed.has(g.key))` (h 28, `pl` 12, rounded, `selected` bg if `space.active` else hover `hover`): dot `●` in `theme()[status] ?? t.unknown` when `space.status`, else `·` in `dim`; `label(space)` truncated; `★` in `dim` when `row.main`. Left click → `run("space.select", { id })`; right click → menu overlay from Global Constraints.
  - Add `// shortcut: bare repos and submodules get a wrong primary from orca-wt info; fix gitInfo if one shows up.` above the probe.

- [ ] **Step 6: Check**
  Run: `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects`
  Expected: check passes with no errors.

- [ ] **Step 7: Commit**
  ```bash
  git add mods/projects/main.js mods/projects/mod.json scripts/install.sh
  git commit -m "feat: projects sidebar mod"
  ```

---

### Task 3: Show it in the `orca` layout and verify in the app

**Files:**
- Modify (outside the repo): `~/.config/herdr-app/layouts/orca.json` — the block with `"id": "spaces"`.

- [ ] **Step 1: Swap the mod.** Change only `"mod": "spaces"` → `"mod": "projects"` in that block (leave its `id`, `size`, `min`). Then `herdr-app status` and confirm there is no `layouts/orca.error` / layout error.

- [ ] **Step 2: Switch to it.** `herdr-app do layout.switch --name orca`.

- [ ] **Step 3: Manual checks in Herdr.app** (each one observed, not assumed):
  1. `Coduct.CTM.UserApp` and `mottanrung-mono` each show one header with their worktrees under it, though neither main checkout is open; counts match the rows.
  2. `herdr-orca-worktrees` row shows `★`.
  3. Collapse `mottanrung-mono`, quit and relaunch Herdr.app → still collapsed.
  4. `+` on `orca-wt-scratch` → Herdr's New worktree dialog for that repo; create `try-2` → the new space appears under `orca-wt-scratch` without first flashing in Other; `orca-setup` still runs for it.
  5. `cd ~/jimmy_dev/orca` in a scratch space's terminal → within ~1 s the row moves to an `orca` group.
  6. Right-click a row → Rename works.
  7. Start `claude` in a space and trigger a permission prompt → that row's dot turns the blocked colour.
  8. The remote machine's spaces (if any open) sit under a `103.170.123.179` group with no `+`.
  9. `ctrl-shift-l` back to `main` → Herdr's own sidebar, unchanged.

- [ ] **Step 4: Record results.** Note any check that failed in the PR/commit message; fix in Task 1/2 code with a test where the logic is pure.
