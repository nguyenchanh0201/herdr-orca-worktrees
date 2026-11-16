# Sidebar Collapse and Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the person's `orca` layout the sidebar drags between 220 and 500 px, the top-left toggle hides it completely (as Orca), a strip button brings it back, and `dsh-tui` shows as "DeepSeek TUI".

**Architecture:** A pure decision function `sidebarStep` in `mods/projects/sidebar.js` (unit-tested) turns the shipped toggle's shrink-to-rail into "restore width + hide". `mods/projects/main.js` runs it in its existing 500 ms `check()`, hides the squeezed list while narrow, and nudges other mods with `setShared` when the hidden state changes. `mods/orca-setup/main.js` shows a "show sidebar" button while hidden. Two config edits outside the repo.

**Tech Stack:** Herdr.app mods (gpui-kit, gpui-base, `herdr`), Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-sidebar-collapse-resize-design.md`

## Global Constraints

- Never edit shipped mods (`workspace-chrome`, `tabs`, …) or `layouts/main.json`. Outside the repo only `~/.config/herdr-app/layouts/orca.json` (back it up first) and `~/.config/herdr-app/programs.json` change.
- Narrow threshold **160 px**; restore width `clamp(shared("sidebar.width") ?? 268, 220, 500)`; layout `min 220`, `max 500`.
- Hide only after the sidebar was seen wide (≥ 160 px, not hidden) during this run; a narrow sidebar at startup is only resized.
- No new timers or `exec`; reuse `projects`' 500 ms `check()`.
- Shared nudge key: `"orca.sidebar.hidden"` (boolean), set only when the hidden state changes.
- Strip button icon: `svg("mods/workspace-chrome/sidebar.svg")`; click → `run("layout.show", { id: "sidebar" })`; visible iff `find(layout(), "sidebar")?.hidden`.
- Commits: no AI co-author trailer.

## Review Focus

1. Opening Herdr with a saved 90 px sidebar must not hide it — test `startup narrow only resizes`.
2. A saved width under 220 (old drag) or missing must restore to 220 / 268 — tests `restore clamps` and `restore default`.
3. After hide → show, a second toggle must hide again (state must count the shown sidebar as wide again) — test `hides again after show`.
4. `cmd-b` hiding/showing (not via our code) must still flip the strip button promptly — test `hidden change reported` + manual check 4.
5. Hidden sidebar must stay hidden across a restart, with the button visible — manual check 5.

---

## Files

- Create: `mods/projects/sidebar.js`, `test/projects-sidebar.test.js`
- Modify: `mods/projects/main.js` (`init` ~line 8-31, `check()` from line 34, `render()` line 143), `mods/orca-setup/main.js` (`render(cx)` ~line 132-165)
- Modify (outside repo): `~/.config/herdr-app/layouts/orca.json`, create `~/.config/herdr-app/programs.json`

### Task 1: Pure `sidebarStep`

**Interfaces — Produces (named exports of `mods/projects/sidebar.js`, no imports):**
- `findNode(tree: object, id: string) => object | null` — depth-first by `id` through `children`.
- `restoreWidth(saved: unknown) => number` — `saved` if a finite number, else 268, clamped to [220, 500].
- `sidebarStep(node: {size?: {px?: number}, hidden?: boolean} | null, state: {seenWide: boolean, hidden: boolean | null}, saved: unknown) => { state, resize: number | null, hide: boolean, hiddenChanged: boolean }`
  - `node` null → no action, state unchanged.
  - `hidden = Boolean(node.hidden)`; `hiddenChanged = state.hidden !== null && hidden !== state.hidden`.
  - hidden → no resize/hide; next `seenWide` false.
  - not hidden, `px < 160` → `resize = restoreWidth(saved)`, `hide = state.seenWide`; next `seenWide` false.
  - not hidden, `px >= 160` (or no px) → no action; next `seenWide` true.
  - next `state.hidden` = `hide ? true : hidden`.

- [ ] **Step 1: Failing tests** in `test/projects-sidebar.test.js` (CommonJS; `let s; test.before(async () => { s = await import("../mods/projects/sidebar.js"); });`). Start state `{ seenWide: false, hidden: null }` = `S0`.
  - `findNode finds nested`: `{id:"r",children:[{id:"a",children:[{id:"sidebar",size:{px:90}}]}]}` → `.size.px === 90`; missing id → `null`.
  - `restore clamps`: `restoreWidth(90) === 220`, `restoreWidth(900) === 500`, `restoreWidth(300) === 300`.
  - `restore default`: `restoreWidth(undefined) === 268`, `restoreWidth("x") === 268`.
  - `startup narrow only resizes`: `sidebarStep({size:{px:90}}, S0, 300)` → `resize 300`, `hide false`, `state.seenWide false`.
  - `toggle after wide hides`: step `{size:{px:268}}` from S0 → no resize, `seenWide true`; then `{size:{px:76}}` with that state and saved 268 → `resize 268`, `hide true`, `state.hidden true`.
  - `hides again after show`: from `{seenWide:false, hidden:true}`, step `{size:{px:268}, hidden:false}` → `hiddenChanged true`, `seenWide true`; then `{size:{px:76}}` → `hide true`.
  - `hidden change reported`: from `{seenWide:true, hidden:false}`, step `{size:{px:268}, hidden:true}` → `hiddenChanged true`, no resize, `seenWide false`.
  - `null node is a no-op`: `sidebarStep(null, S0, 1)` → `resize null`, `hide false`, `hiddenChanged false`, state equal to S0.
- [ ] **Step 2:** `node --test test/projects-sidebar.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement `sidebar.js` as specified.
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** `git add mods/projects/sidebar.js test/projects-sidebar.test.js && git commit -m "feat: sidebar collapse decision for projects"`

### Task 2: Wire it into `projects` and the strip

**Interfaces — Consumes:** Task 1 exports; `herdr`: `layout`, `shared`, `setShared`, `run`.

- [ ] **Step 1: `projects` state.** In `init`, `this.side = { seenWide: false, hidden: null }`.
- [ ] **Step 2: `projects` `check()`.** At its start (before the machine-ready early return, so it also runs while spaces load): `const r = sidebarStep(findNode(layout(), "sidebar"), this.side, shared("sidebar.width"))`; `this.side = r.state`; if `r.resize !== null` → `run("layout.resize", { id: "sidebar", px: r.resize })` and `setShared("sidebar.collapsed", false)`; if `r.hide` → `run("layout.hide", { id: "sidebar" })`; if `r.hide || r.hiddenChanged` → `setShared("orca.sidebar.hidden", this.side.hidden)`.
- [ ] **Step 3: `projects` `render()`.** First line after `theme()`: if `(findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160` → `return div().size_full().bg(t.chrome)`.
- [ ] **Step 4: Strip button.** In `orca-setup` `render(cx)`, compute `hidden = Boolean(findNode(layout(), "sidebar")?.hidden)` (mods are installed as separate folders, so `orca-setup` can't import from `projects`; copy the small `findNode` into `orca-setup/main.js`, as each shipped mod keeps its own `find`). Read `shared("orca.sidebar.hidden")` once in render (no-op use) so the nudge's re-render is meaningful. When `hidden`, add before the "orca" label (line ~162) a 20×20 button: `div().id("orca-show-sidebar")`, rounded 4, hover `t.hover`, `cursor_pointer`, `on_click(() => run("layout.show", { id: "sidebar" }))`, child `svg("mods/workspace-chrome/sidebar.svg").size(14).text_color(t.muted)`. Add `layout` and `shared` to its `herdr` import and `svg` to its `gpui-kit` import (`run` is already imported).
- [ ] **Step 5: Check.** `bash scripts/install.sh projects orca-setup && herdr-app check ~/.config/herdr-app/mods/projects && herdr-app check ~/.config/herdr-app/mods/orca-setup && npm test` → passes.
- [ ] **Step 6:** `git add mods/projects/main.js mods/orca-setup/main.js && git commit -m "feat: orca-style sidebar collapse"`

### Task 3: Config edits and verification

- [ ] **Step 1: Layout.** `cp ~/.config/herdr-app/layouts/orca.json ~/.config/herdr-app/layouts/orca.json.bak2`; in the node `"id": "sidebar"` set `"min": 220`, `"max": 500`; nothing else. `herdr-app status` → `"errors": []`.
- [ ] **Step 2: Rename.** Create `~/.config/herdr-app/programs.json` = `{ "programs": { "dsh-tui": { "name": "DeepSeek TUI" } } }` (it does not exist today; if it does, merge). Confirm no `~/.config/herdr-app/programs.error`.
- [ ] **Step 3: Manual checks** (orca layout; each observed):
  1. Relaunch Herdr: the sidebar (saved at 90 px today) opens at a normal width and visible, not squeezed, not hidden.
  2. Drag its edge: stops at 220 and 500.
  3. Top-left toggle → sidebar disappears (no squeezed list flash beyond a blink); terminal fills the width; the strip shows the sidebar button at its left; click it → sidebar back at its old width.
  4. `cmd-b` hides and shows; the strip button appears/disappears within ~0.5 s.
  5. Hide, quit, relaunch → still hidden, strip button shown.
  6. `+` on a project → the list says "DeepSeek TUI" (with its icon).
  7. `ctrl-shift-l` to `main` → Herdr's own toggle still makes its icon rail there.
