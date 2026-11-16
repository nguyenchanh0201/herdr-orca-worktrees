# Projects sidebar — design (Herdr.app)

Date: 2026-11-16
Part of: herdr-orca-worktrees (see `2026-11-16-herdr-orca-worktrees-design.md`).
First of four Orca features for Herdr.app, in this order: **projects sidebar** →
new worktree with agent picker → sleep/wake → usage meters. Only the sidebar is
designed here.

## Intent

Orca's left sidebar groups every worktree under a header per project (repo), with
a `+` to make a new worktree there and a status icon per worktree. Herdr's shipped
`spaces` sidebar only nests a worktree under its main checkout when that checkout
has its own space, and has no project headers or `+`. We want Orca's grouping in
Herdr.app, as the base the later features (agent picker behind `+`, sleeping moon,
usage meters) hang off.

## Goals

1. A new mod `projects` that lists the local spaces grouped by git repo:
   one header per repo, the repo's spaces as rows under it.
2. A repo gets a header even when its main checkout has no space.
3. Header: collapse arrow, repo name, worktree count, `+` (new worktree).
4. Row: agent status mark, label, click to switch, right-click for Herdr's
   space menu.
5. Shown in place of `spaces` in the person's own `orca` layout only.

## Non-goals (this spec)

- Drag to reorder, the narrow icon-only mode, coloured avatars, ahead/behind
  counts and the git watcher: all in Herdr's `spaces`, not rebuilt here.
- Grouping or probing remote (`machine != null`) spaces' repos.
- Sleep state, agent sub-rows, PR badges, usage meters (later specs).
- A header context menu; project icons/colours; sorting options.

## Anti-goals

- Editing any shipped file (`layouts/main.json`, `mods/spaces`, ...). Only our
  own clone `layouts/orca.json` changes.
- A busy mod: no polling loop that `exec`s, no animation timers (each redraw
  repaints the whole window).
- Showing a space in the wrong group because a probe is stale after the space's
  terminal moved to another repo.

## Constraints

- Same rules as the base design: mods are gpui-kit JS, no Node; git work goes
  through the existing `bin/orca-wt.js info <folder>` → `{ worktree, primary,
  linked }` (or `{ error }`); `herdr-app check mods/projects` must pass;
  `init()` returns early when `checking()`.
- Installed by `scripts/install.sh` like `orca-setup` / `orca-remove` (add
  `projects` to the default list; it gets the same generated `config.js`).

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | New `projects` mod in this repo, swapped into `layouts/orca.json` | Ours, no fork, survives Herdr updates; we write ~300–400 lines and start plainer than Herdr's sidebar |
| B | `mod.clone spaces` → edit `ordered()` / `grouped()` | Small edit, Herdr's polish for free; a never-updated fork of 552 lines of Herdr's code |
| C | Thin projects panel above the shipped `spaces` | Smallest; two lists showing the same spaces |

The user picked A, because the sidebar will grow Orca features (sleep, usage),
at which point a fork would be mostly our code anyway.

## Design

### Where it shows

`layouts/orca.json` (the person's clone of `main`, already docking
`orca-setup`): the block `"id": "spaces"` changes `"mod": "spaces"` →
`"mod": "projects"`. The `agents` block below it stays. `install.sh` does not
edit the layout; the edit is one documented manual step (or a one-line
`node -e` in the README). `ctrl-shift-l` back to `main` restores Herdr's
sidebar.

### Data

- Spaces: `spaces()`. A space's *place* is its first terminal's live folder
  (`panes()` cwd of a pane in one of its tabs), else `space.folder` — the same
  rule the shipped mods use.
- Repo of a place: `orca-wt info <place>`, run with `cx.spawn` + `exec`,
  cached in `this.repo[place] = { primary, linked } | null` (null = not a git
  repo or error). Probed once per distinct place; a space whose place changes
  is probed again (that keeps groups right after a `cd`). At most 6 probes in
  flight (the shipped mod's limit, for open-file / exec caps).
- Not probed yet → the space shows in its old group if it had one. A space
  with no group yet is **held back** (not drawn) until its probe answers, at
  most 1 s, then falls back to **Other**, so a new worktree appears under its
  repo instead of jumping there (the shipped `spaces` mod does the same).
- First start: "Loading…" until the first round of probes is back (at most
  3 s), instead of every space flashing through Other.

### Grouping and order

Pure function `group(spaces, placeOf, repoOf) → [{ key, name, rows, primarySpace }]`
in `mods/projects/group.js` (no imports, so it can be unit-tested):

- Key = `primary` path; name = its basename. Local spaces only.
- Remote spaces: one group per machine, named after the machine, rows in
  `spaces()` order, no `+` (the person has one remote machine connected).
- Non-git local spaces: one **Other** group, last, no `+`.
- Group order: order of each group's first space in `spaces()` (keeps the
  order the person set in Herdr). Rows in a group: the main checkout's space
  first (`linked === false`), then `spaces()` order.
- `primarySpace` = id of the main checkout's space, or null.

### Header (28px)

`▾/▸  name  count  … +`, `theme()` colours (`muted` for count).
- Count = the group's **open spaces** (rows), not worktrees on disk; no extra
  git probe.
- Click anywhere but `+` toggles collapse. Collapsed keys are kept in
  `localStorage` (`projects.collapsed`, JSON array of keys; wrapped in
  try/catch).
- `+` opens Herdr's shipped worktree dialog in the repo's **main checkout**,
  using the dialog's "repo without a space" form so it never branches from
  another worktree's HEAD:
  `openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280,
  props: { folder: <primary>, machine: null, action: "new" } })`.
  A new branch therefore starts from whatever the main checkout has checked
  out. (Branching from a fixed base like `origin/main` is the next spec's
  dialog.)
- A collapsed group whose spaces include the active one still shows that row.

### Row (28px)

`mark  label  ★?` with `selected` background when `space.active`, `hover`
otherwise.
- Mark: `space.status` → a dot in `theme()[status]` (working, blocked, done,
  idle); `·` in `dim` when null. Blocked/done read as "needs you".
- Label: `space.named ? space.name : (space.branch ?? space.name)`.
- `★` in `dim` on the main checkout's row.
- Left click: `run("space.select", { id })`.
- Right click: Herdr's shipped space menu, as `spaces` opens it:
  `openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260,
  props: { tab: "space", target: { id } } })` (rename, close, colour, ...).
- Indented 12px under the header.

### List

The whole list scrolls (`overflow_y_scroll` with a `ScrollHandle`; the person
has ~20 spaces open). When the active space changes, its row is scrolled into
view, as the shipped `spaces` mod does.

### Refresh

`render(cx)` gets a plain `Context`, not the `AsyncContext` that starts tasks,
and the docs don't promise a redraw when only a pane's cwd changes. So, like
the shipped `spaces` mod (250 ms) and `orca-setup` (3 s):
- `init` starts `cx.timer.every(500, check)`. `check` compares space ids and
  places against the last seen ones. It runs **no `exec`**: it only starts
  probes (`cx.spawn`) for places it hasn't seen, and calls `cx.notify()` when
  something changed.
- A probe finishing calls `cx.notify()` after the await (see commit 89647f5).
- `render()` only reads `spaces()`, `panes()` and the cache. It has no side
  effects.

### Empty / loading

- `machines()` local layout not `ready` → "Loading…".
- No spaces → "No spaces" in `muted`.

### Known limits

- Bare-repo layouts (`repo.git` + worktrees beside it) and spaces inside a
  submodule get a wrong `primary` from `orca-wt info`; not used here (all of
  the person's repos are normal checkouts). Marked as a `shortcut:` comment.
- The `orca` layout loses the shipped sidebar's machine login / reconnect /
  "new space on machine" controls; for those, switch to `main`
  (`ctrl-shift-l`) or use Settings > Machines.

## Testing

- `node --test`: `group()` with fixtures — main + 2 worktrees; worktrees with no
  main space (header still there, `primarySpace` null); non-git space → Other;
  remote space → machine group; order follows `spaces()`; a space whose place
  moved to another repo lands in the new group.
- `herdr-app check mods/projects`.
- Manual in Herdr.app (orca layout): two repos, one with its main checkout
  closed; headers, counts, collapse survives restart, `+` opens the worktree
  dialog with the right repo, new worktree appears under its repo, right-click
  menu renames, status dot turns blocked when Claude asks permission.

## Left to the builder

- (Settled) `group.js` is ESM; the repo's `package.json` says `commonjs`, so
  add `mods/package.json` = `{"type":"module"}` and test it with
  `await import("../mods/projects/group.js")`. Checked on Node 24.
  `install.sh` copies `mods/<name>/` only, so that file never reaches Herdr.
- Exact glyphs and spacing, within the theme colours above.
