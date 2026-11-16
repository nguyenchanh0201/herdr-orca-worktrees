# Worktree Agent Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The projects sidebar's `+` opens a small "Terminal or which agent?" popup; choosing opens Herdr's New worktree dialog so the new space's only tab runs that agent.

**Architecture:** New popup mod `mods/orca-new/` modelled on the shipped `~/.config/herdr-app/mods/new-menu/main.js`. It lists `knownAgents()` and, on a choice, opens the shipped `worktree` dialog with `argv`/`tab` props, which already does `space.new { folder, tab, argv }`. `mods/projects/main.js` points its `+` at the popup.

**Tech Stack:** Herdr.app mods (gpui-kit, gpui-base, `herdr`), `herdr-app check`.

**Spec:** `docs/superpowers/specs/2026-11-17-worktree-agent-picker-design.md`

## Global Constraints

- Never edit shipped mods (`worktree`, `new-menu`, `menu`); never fork Herdr's worktree creation.
- `init()` returns early when `checking()` is true; `herdr-app check` must pass for `orca-new` and `projects`.
- Popup open: `openOverlay({ mod: "orca-new", kind: "popup", width: 250, height: 260, props: { folder: <primary> } })`.
- Choice → `closeOverlay(props().overlay)` then `openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { folder, machine: null, action: "new", argv: agent.run, tab: agent.name } })`. Terminal: same without `argv`/`tab`.
- Agent cache: read `shared("new-menu.agents")?.[""]`, write back `setShared("new-menu.agents", { ...shared("new-menu.agents"), "": agents })` — the shipped menu's shape, local machine key `""`.
- Installed agents only, in `knownAgents()` order; keys `1`–`9`.
- Copy: "Terminal", "Start an agent", "Checking installed agents…", "Could not check installed agents".
- Commits: no AI co-author trailer.

## Review Focus

1. `knownAgents()` rejects (shell check fails) → popup still offers Terminal and shows "Could not check installed agents" — Task 1 Step 3 + manual check 5.
2. Number key pressed with Ctrl/Cmd/Alt held must not pick an agent (that's a shortcut) — Task 1 Step 3 key handler, as `new-menu` does.
3. Esc in the popup or in the branch dialog creates nothing — manual check 4.
4. dsh-tui missing from the list → fixed by `programs.json`, not code — manual check 2.
5. The popup closes before the dialog opens, so the dialog gets keyboard focus — manual check 3.

No unit tests: the mod has no logic beyond filtering `installed` and building one props object; `herdr-app check` plus the manual run cover it.

---

## Files

- Create: `mods/orca-new/main.js`, `mods/orca-new/mod.json`
- Modify: `mods/projects/main.js:245-251` (the `+` handler), `scripts/install.sh:16`

### Task 1: `orca-new` popup and wiring

**Interfaces:**
- Consumes: `props().folder` (repo's main checkout path), `props().overlay`.
- Produces: default-exported `class OrcaNew extends View`; no config.js needed (it runs no `exec`), but `install.sh` writes one anyway — harmless.

- [ ] **Step 1: `mods/orca-new/mod.json`** = `{ "place": "none", "title": "New worktree" }`.

- [ ] **Step 2: `init(_p, cx)`** — return if `checking()`. `this.agents = shared("new-menu.agents")?.[""] ?? []`, `this.failed = false`, `this.handle = cx.focus_handle(); this.handle.focus();`, then `cx.spawn` → `await knownAgents({ on: null })`, write the cache (Global Constraints), on throw `this.failed = true`; `cx.notify()` after the await.

- [ ] **Step 3: `render()`** — follow `new-menu/main.js:40-72` for look (popover bg, 31px rows, `svg`/`image` icon by `a.tint`, dim hint at right). `installed = this.agents.filter(a => a.installed)`. Rows: Terminal (no hint); label "Start an agent"; one row per installed agent with hint `i < 9 ? String(i + 1) : ""`; the "Checking…" / "Could not check…" line when `failed` or empty. `.track_focus(this.handle).on_key_down(e)`: ignore when `e.modifiers.control || platform || alt`; `/^[1-9]$/` → `installed[n-1]` → `choose(agent)`. `choose(agent | null)` does the Global Constraints open with `props().folder`.

- [ ] **Step 4: Point `projects` at it.** In `mods/projects/main.js:245-251` replace the worktree `openOverlay` with the popup open from Global Constraints (`props: { folder: g.primary }`). Keep `cx.stop_propagation()`.

- [ ] **Step 5: Install list.** `scripts/install.sh:16` → `MODS=(orca-setup orca-remove projects orca-new)`.

- [ ] **Step 6: Check.**
  Run: `bash scripts/install.sh && herdr-app check ~/.config/herdr-app/mods/orca-new && herdr-app check ~/.config/herdr-app/mods/projects && npm test`
  Expected: both checks pass, tests green.

- [ ] **Step 7: Commit**
  ```bash
  git add mods/orca-new mods/projects/main.js scripts/install.sh
  git commit -m "feat: agent picker for new worktree"
  ```

### Task 2: Verify in Herdr.app

- [ ] **Step 1: Manual checks** (orca layout; each observed):
  1. `+` on `orca-wt-scratch` → popup lists Terminal, then Claude, Codex, agy, DSH with `1`–`4`.
  2. If DSH is missing: add `"dsh-tui": { "name": "DSH", "run": ["dsh-tui"] }` under `programs` in `~/.config/herdr-app/programs.json`, confirm no `programs.error`, reopen → listed.
  3. Press `1` → branch dialog has focus; type `try-agent`, Enter → new space under `orca-wt-scratch` with a tab named "Claude" running claude, plus orca-setup's Setup tab.
  4. Esc in the popup, and Esc in the branch dialog → no worktree, no space.
  5. Terminal → plain shell space, same as before this change.
  6. Cmd+1 with the popup open does not start an agent.
- [ ] **Step 2:** Remove the test worktree with the strip's Remove button. Note any failed check in the commit/PR.
