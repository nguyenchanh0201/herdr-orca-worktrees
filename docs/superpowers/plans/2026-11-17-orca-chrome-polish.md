# Orca Chrome Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `orca` layout's chrome match Orca: usage on the left of the bottom bar, Orca's two-pane usage popup, a Create worktree dialog with a local/remote branch picker, a Projects header with four icons, and the sidebar toggle at the top.

**Architecture:** Pure logic in Node (`src/usage/format.js`, new `src/worktree.js`, `mods/projects/*.js` pure helpers) under `node:test`; mods stay thin gpui-kit views. Slow work (worktree create) runs in the long-lived `projects` sidebar via `setShared` requests, as clone already does. The tab bar change is a marked copy of Herdr's shipped `tabs` mod.

**Tech Stack:** Node 24, `node:test`, git CLI, Herdr.app mods (gpui-kit `Select`/`Combobox`/`Popup`, gpui-base `InputState`/`Input`, `herdr`).

**Spec:** `docs/superpowers/specs/2026-11-17-orca-chrome-polish-design.md` (mockup: https://claude.ai/artifact/HKuixomWTzpo32xi2aG7Ry)

## Global Constraints

- Never edit shipped mods or `layouts/main.json`. Outside the repo only `~/.config/herdr-app/layouts/orca.json` changes (back it up before each edit).
- No new timers or `exec` loops; reuse existing `check()` / `tick()` timers.
- Shared keys (exact): `orca.usage.refresh` `{at, force}`, `orca.usage.mode` `"compact"|"detailed"`, `orca.usage.data`, `orca.projects.request` (adds `kind: "worktree"`), `orca.projects.worktree` `{id, state, error?}`, `orca.projects.repos` `[{key, name, primary}]`, `orca.projects.options` `{sort: "added"|"name", hideMain: bool}`, `orca.sidebar.hidden`.
- `localStorage` keys: `usage.mode`, `projects.view` (`"projects"|"activity"`), `projects.options`, `agent.last`, plus existing ones. Every access in try/catch.
- Bar colours by used %: `< 80` `muted`, `≥ 80` `theme().ansi3`, `≥ 90` `ansi1`.
- Worktree path = `<worktrees.directory or ~/.herdr/worktrees>/<repo basename>/<slug(branch)>`, `slug` copied from `~/.config/herdr-app/mods/worktree/main.js`.
- Git commands from the helper: `timeout` 590 000 ms; errors = last 20 stderr lines.
- Mods draw nothing without `props().overlay` (overlay mods) and return early on `checking()`.
- Commits: no AI co-author trailer.

## Review Focus

1. Pressing Create right after the dialog opens (base `main` already open, no name) must create a generated-name branch, never fail — test `default state creates generated branch` (Task 4).
2. A typed name that exists only on a remote must be refused — test `name equal to remote-only branch refused` (Task 4).
3. Remote-only branch with no name must produce a local branch tracking it — test `remote-only checks out tracking` (Task 4).
4. The Detailed/Compact choice must survive a restart and the panel must show the right side on first open — Task 2 Step 3 (strip publishes saved mode on start) + manual check 3.
5. ◧ must appear at the top only while the sidebar is hidden and with no empty gap — test `orca-tabs differs only in the marked block` (Task 7) + manual check 9.

---

## Files

- Modify: `src/usage/format.js`, `mods/orca-usage/format.js`, `mods/orca-usage-panel/format.js`, `test/usage-format.test.js`, `test/usage-mods.test.js`
- Modify: `mods/orca-usage/main.js`, `mods/orca-usage-panel/main.js`, `mods/orca-setup/main.js`
- Create: `mods/orca-usage/refresh.svg`, `mods/projects/bell.svg`, `mods/projects/sliders.svg`
- Create: `src/worktree.js`, `test/worktree.test.js`; modify `bin/orca-wt.js`
- Create: `mods/orca-worktree/{main.js,mod.json}`; delete `mods/orca-new/`
- Modify: `mods/projects/main.js`, `mods/projects/group.js`, `test/projects-group.test.js`; `mods/orca-project/main.js` (new `options` mode)
- Create: `mods/orca-tabs/` (copy of shipped `tabs`), `test/orca-tabs.test.js`
- Modify: `scripts/install.sh:16`

### Task 1: Usage formatting additions

**Interfaces — Produces** (CJS in `src/usage/format.js`, same names as ESM in both mod copies):
- `shortGroup(label: string) => string` — text before `" · "`, minus trailing `" Models"`.
- `chipText(p: Provider, mode: "compact"|"detailed", now) => string` — compact: today's `headline()` except named buckets (`minutes` 300/10080 with a ` · `-style agy label) read `` `${pct}% ${shortGroup(label)} ${minutes===10080?"wk":minutes===300?"5h":""}`.trim() ``; detailed: every window `"{pct}% {until || shortLabel}"` joined `" · "`.
- `windowName(w) => string` — `"Fable"` if label is Fable, else 300 → `"Session"`, 10080 → `"Weekly"`, else `w.label`.
- `updatedText(fetchedAt, now) => string` — `< 60 s` → `"Updated just now"`, else `"Updated {N}m ago"` (`"{N}h ago"` from 60 min).
- `barColor` changes to return `"muted" | "ansi3" | "ansi1"`.

- [ ] **Step 1: Tests** in `test/usage-format.test.js`: `shortGroup("Gemini Models · Weekly Limit Remaining") === "Gemini"`, `shortGroup("Gemini 4 Argon") === "Gemini 4 Argon"`; agy provider whose top window is `{label:"Gemini Models · Weekly Limit Remaining",minutes:10080,usedPercent:20}` → compact `"20% Gemini wk"`; 5h bucket → `"… 5h"`; minutes 0 → no suffix; Claude compact unchanged (`"42% 3h 12m"`); detailed with 5h 42% (+3h12m) and Weekly 18% (+4d2h) → `"42% 3h 12m · 18% 4d 2h"`; `windowName` for Fable (minutes 10080) → `"Fable"`, 300 → `"Session"`, 10080 → `"Weekly"`, bucket → label; `updatedText` at 59 s / 60 s / 3 600 s; `barColor(79)==="muted"`. Extend `test/usage-mods.test.js` so both ESM copies match on these too.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement in all three files. **Step 4:** `npm test` → pass.
- [ ] **Step 5:** `git add src/usage/format.js mods/orca-usage/format.js mods/orca-usage-panel/format.js test/usage-format.test.js test/usage-mods.test.js && git commit -m "feat: orca-style usage chip text"`

### Task 2: Strip — usage left, setup right

- [ ] **Step 1: `orca-setup`.** Remove the `orca` label and the show-sidebar button plus its `findNode` / `orca.sidebar.hidden` / `layout` reads. Right-align the row: status (as today) then Remove. `herdr-app check` passes.
- [ ] **Step 2: Icon.** `mods/orca-usage/refresh.svg`: 24×24, `fill="none" stroke="currentColor" stroke-width="2"`, two arcs with arrowheads (lucide "refresh-cw" shape, drawn fresh).
- [ ] **Step 3: `orca-usage`.** Left-aligned row `px(10)`: `Used` (`dim`) · chips (`chipText(p, mode, now)`) · refresh button (`svg("mods/orca-usage/refresh.svg").size(13)`, `muted`, hover `foreground`, `.spin(900)` while `fetching`) → `setShared("orca.usage.refresh", { at: Date.now(), force: true })`. Mode: read `localStorage` `usage.mode` in `init` (default `"compact"`) and `setShared("orca.usage.mode", mode)` once; in `checkRefresh` (or render) adopt a changed shared value and save it. Detailed chip: icon + 48×6 bar (`border` track, `muted` fill, most-used %) + text. Chip fitting by measured width per mode (drop lowest-used first). Click on chips → `openOverlay({ mod: "orca-usage-panel", kind: "popup", width: 760, height: 420 })`.
- [ ] **Step 4:** `bash scripts/install.sh orca-setup orca-usage && herdr-app check ~/.config/herdr-app/mods/orca-setup && herdr-app check ~/.config/herdr-app/mods/orca-usage && npm test` → pass.
- [ ] **Step 5:** `git add mods/orca-setup mods/orca-usage && git commit -m "feat: usage on the left of the orca strip"`

### Task 3: Two-pane usage panel

- [ ] **Step 1: Rewrite `orca-usage-panel` render** to section 4 of the spec: left 360 px (header `Usage` + `all agents` + refresh; segmented **Detailed | Compact** writing `orca.usage.mode`; 48 px provider rows sorted by highest used %, icon 20 px, name, reset text, `{pct}%`, `›`; hover or click sets `this.selected`; default first; unavailable rows last, dim, reason subtitle, not selectable). Right 400 px: icon + name + `updatedText`; box (`raised` bg, `border`, radius 10) titled `Default account`; per window `windowName(w)`, 6 px bar coloured by `barColor`, `{pct}% used` / `Resets in {until}` (`Resets now` when ≤ 0); error text in `blocked`; `ok` + no windows → `No limits reported`.
- [ ] **Step 2:** `bash scripts/install.sh orca-usage-panel && herdr-app check ~/.config/herdr-app/mods/orca-usage-panel && npm test` → pass.
- [ ] **Step 3:** `git add mods/orca-usage-panel && git commit -m "feat: orca-style two-pane usage panel"`

### Task 4: Worktree helper (`src/worktree.js`)

**Interfaces — Produces:**
- `slug(branch) => string` (copied verbatim from the shipped worktree mod, with its hash fallback).
- `SEA_CREATURES: string[]` (≥ 50 lower-case single words) and `suggestName(used: Set<string>, random = Math.random) => string` (random unused; when all used, `"<name>-2"`, `-3`…).
- `listBranches(repo, root) => { default, local: string[], remote: string[], checkedOut: Record<string,string>, suggested } | { error }` (`root` = worktrees directory, for `used` folder names).
- `addWorktree(repo, { base, name, root }) => { path, branch } | { error }` implementing spec cases 1–4.
- CLI: `orca-wt branches <repo> --root <dir>`, `orca-wt worktree-add <repo> --base <ref> [--name <b>] --root <dir>`.

- [ ] **Step 1: Test fixture** in `test/worktree.test.js`: build a bare `origin.git` from `makeRepo()`'s primary (`git clone --bare`), clone it to `work/` (so `origin/HEAD`, `origin/main` exist), create `origin`-only branch `feat/remote-only` (push from a temp clone), a local-only `fix/local`, and a temp `root` dir. Detect the default branch name the test git uses (`main` or `master`) and assert against that.
- [ ] **Step 2: Tests:**
  - `branches lists local and remote`: `local` includes default and `fix/local`; `remote` includes `origin/<default>` and `origin/feat/remote-only`; no `origin/HEAD`; no `refs/heads/` prefixes; `default` = local default name; `checkedOut[<default>]` = `work` path; `suggested` is in `SEA_CREATURES`.
  - `new name from local base`: `{ base: "fix/local", name: "try-x" }` → branch `try-x` at `<root>/work/try-x`, `git -C path rev-parse HEAD` = `fix/local` commit.
  - `new name from remote base has no upstream`: base `origin/feat/remote-only`, name `n1` → `git rev-parse --abbrev-ref n1@{upstream}` fails.
  - `existing local name refused` → error contains `already exists`.
  - `name equal to remote-only branch refused`: name `feat/remote-only` → error contains `exists on origin`.
  - `invalid name refused`: `"bad..name"` → error.
  - `free local branch opens`: base `fix/local`, no name → branch `fix/local` checked out at its path.
  - `remote-only checks out tracking`: base `origin/feat/remote-only`, no name → branch `feat/remote-only`, upstream `origin/feat/remote-only`.
  - `remote with existing local uses local`: after the previous case's worktree is removed, base `origin/feat/remote-only` again → uses local `feat/remote-only` (no `-b` error).
  - `default state creates generated branch`: base = default (checked out in `work`), no name, `random = () => 0` → branch = first unused `SEA_CREATURES` entry, new worktree created.
  - `suggestName skips used and suffixes`: all names used → ends in `-2`.
  - `existing path refused`: pre-create `<root>/work/<slug>` → error.
  - `slug`: `"feat/x"` → `"feat-x"`.
  - CLI: `spawnSync(node, ["bin/orca-wt.js","branches", work, "--root", root])` → JSON with `local`.
- [ ] **Step 3:** run → FAIL. **Step 4:** implement (`spawnSync("git", ["-C", repo, ...])`, `for-each-ref --sort=-committerdate --format=%(refname:short)`, `symbolic-ref --short refs/remotes/origin/HEAD`, `worktree list --porcelain`, `check-ref-format --branch`, `ls-remote`-free remote check via `for-each-ref refs/remotes/*/<name>`). Wire both CLI commands; existing commands unchanged.
- [ ] **Step 5:** `npm test` → pass. **Step 6:** `git add src/worktree.js bin/orca-wt.js test/worktree.test.js && git commit -m "feat: branch listing and worktree creation in orca-wt"`

### Task 5: Create worktree dialog + sidebar wiring

- [ ] **Step 1: `projects` publishes repos** — after grouping in `render` (or `check`), when the list of repo groups changes, `setShared("orca.projects.repos", groups.filter(kind==="repo").map(g => ({ key: g.key, name: g.name, primary: g.primary })))`.
- [ ] **Step 2: `projects` handles `kind: "worktree"`** in its existing request handler: `setShared("orca.projects.worktree", { id, state: "running" })`; read `worktrees.directory` from `${appHome()}/settings.json` (default `~/.herdr/worktrees`, `~` expanded with `home()`); `cli(["worktree-add", repo, "--base", base, ...(name ? ["--name", name] : []), "--root", root], 600000)`; error → `{ id, state: "error", error }` + toast "Create worktree"; success → `run("space.new", { folder: r.path, tab: agent?.name, argv: agent?.run })`, `{ id, state: "done" }`.
- [ ] **Step 3: `mods/orca-worktree/`** — `mod.json` `{ "place": "none", "title": "Create worktree" }`; dialog per spec section 5: Project `Select` (from `orca.projects.repos`, default `props().repo`, folder-plus → `orca-project` `add`), Create From combobox (search + Local / Remote sections + `(default)` + `· open in <folder>` + `checks out as <b>` for remote-only, keyboard Up/Down/Enter, Esc closes list only; branches from `exec(node,[cli,"branches",repo,"--root",root])` on open and on project change), Branch name `Input` (placeholder = `suggested` when base is open else `New branch name (optional)`; hint line per spec), Agent `Select` (Terminal + installed `knownAgents()`, default `localStorage` `agent.last`), **Create ⌘↵** (solid; Enter in name field; disabled while loading/creating; "Creating…" while the shared state for this id is `running`; error above the button in `blocked`; `done` → save `agent.last`, close). If the branch list can't draw past the dialog bottom, grow the dialog height while it's open.
- [ ] **Step 4: Point `+` at it.** Every project-header `+` → `openOverlay({ mod: "orca-worktree", kind: "dialog", width: 560, height: 420, props: { repo: g.primary } })`. Delete `mods/orca-new/`; `install.sh` list drops `orca-new`, adds `orca-worktree`.
- [ ] **Step 5:** `bash scripts/install.sh && herdr-app check ~/.config/herdr-app/mods/orca-worktree && herdr-app check ~/.config/herdr-app/mods/projects && npm test` → pass.
- [ ] **Step 6:** `git add -A mods/orca-worktree mods/orca-new mods/projects scripts/install.sh && git commit -m "feat: orca-style create worktree dialog"`

### Task 6: Projects header

**Interfaces — Produces** (pure, `mods/projects/group.js`): `activitySort(agents, sinceMap) => AgentInfo[]` (blocked > done > working > idle, then larger `since.at` first), `attentionCount(agents) => number` (blocked + done), `sortGroups(groups, "added"|"name") => Group[]` (name: repo groups by name, case-insensitive; machine groups after; `other` last), `hideMainRows(groups) => Group[]` (drops `row.main` rows; keeps empty headers).

- [ ] **Step 1: Tests** in `test/projects-group.test.js` for the four helpers (one case each plus `other` last after name sort and an empty group kept by `hideMainRows`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** pass.
- [ ] **Step 5: Icons.** `mods/projects/bell.svg`, `mods/projects/sliders.svg` (24×24 stroke, `currentColor`).
- [ ] **Step 6: Header row** in `projects` render, fixed above the scroll list, per spec section 6: title (`Projects` / `Activity`), collapse-all chevron, bell (badge = `attentionCount`, pressed when `view === "activity"`, toggles `projects.view`), sliders → `openOverlay({ mod: "orca-project", kind: "popup", width: 240, height: 260, props: { mode: "options" } })`, folder-plus → `orca-project` `add`, plus → Create worktree for the active space's group (else the first repo group; dim/disabled with none). Remove the bottom `+ Add project` row. Activity body: `activitySort(agents(), this.since)` rows (reuse `renderAgent` with the space label as a second line). Projects body applies `sortGroups` then `hideMainRows` when the options say so.
- [ ] **Step 7: Options popup** — `orca-project` mode `options`: Collapse all, Expand all (each sends `setShared("orca.projects.options", { ...opts, collapse: "all"|"none", at: Date.now() })`), Sort projects (Order added / Name, ✓ on current), Hide main checkouts (toggle). `projects` adopts changes, saves `localStorage` `projects.options`, publishes it on start.
- [ ] **Step 8:** `bash scripts/install.sh projects orca-project && herdr-app check ~/.config/herdr-app/mods/projects && herdr-app check ~/.config/herdr-app/mods/orca-project && npm test` → pass.
- [ ] **Step 9:** `git add mods/projects mods/orca-project test/projects-group.test.js && git commit -m "feat: orca-style projects header"`

### Task 7: `orca-tabs` and the top toggle

- [ ] **Step 1: Copy.** `cp -R ~/.config/herdr-app/mods/tabs mods/orca-tabs` (then drop `gpui-kit.d.ts`, `jsconfig.json`), `mod.json` title `"Tabs (orca)"`, replace `mods/tabs/` asset paths with `mods/orca-tabs/`. Header comment: `// Copied from Herdr 0.1.16 mods/tabs. Only change: the ORCA-TOGGLE block. Re-copy on Herdr updates.`
- [ ] **Step 2: Change.** Between `// ORCA-TOGGLE start` / `// ORCA-TOGGLE end` comments: when `sidebar?.hidden`, a 26 px button with `svg("mods/workspace-chrome/sidebar.svg").size(14)` → `run("layout.show", { id: "sidebar" })`, inserted as the first child after `pl(lightsPadding)`. Read `shared("orca.sidebar.hidden")` in render so `projects`' nudge redraws it.
- [ ] **Step 3: Test** `test/orca-tabs.test.js` — **`orca-tabs differs only in the marked block`**: read both files (skip when `~/.config/herdr-app/mods/tabs/main.js` is missing), strip the header comment and the `ORCA-TOGGLE` block, normalise `mods/orca-tabs/` → `mods/tabs/`, assert equal.
- [ ] **Step 4:** `install.sh` list adds `orca-tabs`; `bash scripts/install.sh orca-tabs && herdr-app check ~/.config/herdr-app/mods/orca-tabs && npm test` → pass.
- [ ] **Step 5:** `git add mods/orca-tabs test/orca-tabs.test.js scripts/install.sh && git commit -m "feat: sidebar toggle at the top via orca-tabs"`

### Task 8: Layout and verification

- [ ] **Step 1: Layout.** `cp ~/.config/herdr-app/layouts/orca.json ~/.config/herdr-app/layouts/orca.json.bak-polish`. In `orca-strip`: children become `[{ "id": "orca-usage", "type": "block", "size": { "weight": 1 }, "content": { "mod": "orca-usage" } }, <orca-setup block with "size": { "px": 260 }>]`. The tabs block `content.mod` `"tabs"` → `"orca-tabs"`. `herdr-app status` → `"errors": []`.
- [ ] **Step 2: Manual checks** (stop and ask the person; each observed against the mockup):
  1. Bottom bar: `Used ✳ … ◎ … ▲ 20% Gemini wk ⟳` left; setup status + Remove right; no "orca".
  2. ⟳ spins, then "Updated just now" in the panel.
  3. Panel: rows with `›`, side card Session / Weekly / Fable; Detailed/Compact switches the chips and stays after a restart; the 760 px popup stays on screen.
  4. `+` on a project → Create worktree with that project, `main (default)`, generated name hint; ⌘↵ → new sea-creature branch space with the chosen agent and a Setup tab.
  5. Pick `origin/<remote-only>` with no name → local tracking branch space.
  6. Type a name that exists on origin only → the refusal message.
  7. Header: bell badge appears when an agent is blocked; bell → Activity list → back (remembered); options → collapse/expand all, sort by name, hide main checkouts; folder-plus → Add project; `+` → Create worktree for the active project; no bottom Add project row.
  8. Esc during "Creating…" → the space still opens.
  9. Hide the sidebar (top toggle or ⌘B) → ◧ right after the window buttons, no gap; click → sidebar back.
  10. `ctrl-shift-l` to `main` → Herdr's own chrome, unchanged.
