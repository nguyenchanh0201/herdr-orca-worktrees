# herdr-orca-worktrees — design (Herdr.app)

Date: 2026-11-16
Target: **Herdr.app** (`/Applications/Herdr.app` 0.1.16, terminals in
herdr-core `hc` 0.1.21, home `~/.config/herdr-app`). Not the `herdr` TUI.
Source of truth for the app API: `~/.config/herdr-app/AGENTS.md`,
`herdr.d.ts`, `gpui-kit.d.ts` (rewritten by the app on every start).

## Intent

Use Herdr.app instead of Orca.app for worktree work, because Orca costs
~700 MB resident and Herdr.app + herdr-core cost ~82 MB (measured). Herdr.app
already has Orca's worktree basics: the built-in `worktree` mod (New / Open /
Remove worktree from the space menu and + menu, checkouts under
`<worktrees.directory>/<repo>/<branch>`, default `~/.herdr/worktrees`), and the
`spaces` sidebar nests worktree spaces under their repo.

What is missing, and what this project adds: Orca's `orca.yaml` /
`.worktreeinclude` behaviour on new worktrees, and `scripts.archive` before a
worktree is removed.

## Goals

1. When a new worktree space appears, apply the repo's config with Orca's
   semantics: shared directories (symlinks), `.worktreeinclude` copies, then
   `scripts.setup` in a visible **Setup** tab of that space.
2. A **Remove worktree (Orca)** dialog that checks for uncommitted work, runs
   `scripts.archive`, removes our symlinks, removes the checkout and closes
   the space.

## Non-goals

- **Sleeping agents** (worktree-level sleep). Herdr.app can kill a terminal
  but has no resume; that needs its own design. Separate follow-up spec.
- Replacing or editing the built-in `worktree` mod (approach A: we sit beside
  it and keep Herdr's updates).
- `defaultTabs`, `issueCommand`, `setupAgentStartupPolicy`,
  `environmentRecipes`, Orca Settings-level paths and command-source policy.
- Remote-machine spaces (`space.machine != null`): skipped.
- Orca's copy budget (2 GiB / 50,000 entries); bare-repo layouts; Windows.
- Running setup for worktrees that existed before they were created through
  the app (e.g. the 12 spaces on `~/orca/workspaces/...`), or on Open worktree.

## Anti-goals

- Parsing `orca.yaml` differently from Orca.
- Destroying data: never overwrite a path in a worktree; never force-remove
  without an explicit click; cancel anywhere leaves the worktree untouched.
- Setup running twice for one worktree, or running on old worktrees.
- A busy mod: no tight polling, no animation timers (each redraw repaints the
  whole window).

## Constraints

- Mods are JavaScript on gpui-kit: no Node APIs, no DOM, no `setTimeout`;
  `exec(cmd, args, { cwd, timeout })` runs programs in the user's real
  environment (timeout default 30 s, max 600 s). Mods re-render when
  `spaces()` changes.
- No trust prompt: setup and archive scripts always run (user decision).
- One npm dependency, `yaml` `^2.9.1` (same as Orca), used only by the Node
  helper, never imported by a mod.
- `herdr-app check <mod folder>` must pass for every mod; `init()` must
  return early when `checking()` is true.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | New mods beside the built-in `worktree` mod | Keeps Herdr's updates to `worktree`. Setup lands a moment after the space appears. |
| B | `mod.clone` the built-in `worktree` mod and edit it | Perfect ordering (setup before any agent), but a fork that misses upstream changes. |
| C | Standalone CLI (`orca-wt new <branch>`) + `herdr-app do` | No UI dependency, but outside the app's menus. |

The user picked A.

## Design

### Shape: thin mods, one Node helper

Mods can't use Node or npm, but can `exec` programs. All file and git logic
lives in a Node CLI, `bin/orca-wt.js`, tested with `node:test`. The mods only
watch, ask and call it. This also keeps the `orca.yaml` parser identical to
Orca's (`yaml` library).

```
~/jimmy_dev/herdr-orca-worktrees/        (git repo)
  bin/orca-wt.js          CLI: prints one JSON object per call
  src/orca-config.js      orca.yaml + .worktreeinclude parsing (pure)
  src/fs-ops.js           isIgnored, linkShared, copyIncludes, findOurSymlinks
  src/runner.js           buildRunner, orcaEnv
  mods/orca-setup/        main.js, mod.json { "place": "bottom", "size": 28, "title": "Orca" }
  mods/orca-remove/       main.js, mod.json { "place": "none", "title": "Remove worktree (Orca)",
                                              "overlay": { "kind": "dialog", "width": 560 } }
  scripts/install.sh      links/copies mods into ~/.config/herdr-app/mods, writes config
  test/
```

`scripts/install.sh` puts both mods into `~/.config/herdr-app/mods/`
(symlink if Herdr loads symlinked mod folders, else copy; builder verifies
with `herdr-app check`) and writes `mods/orca-setup/config.js` and
`mods/orca-remove/config.js` exporting `{ node: <absolute node path>, cli:
<absolute path to bin/orca-wt.js> }` (absolute because `node` comes from nvm).
It touches nothing else in `~/.config/herdr-app`.

### Helper CLI: `orca-wt`

All commands print a single JSON object on stdout and exit 0; failures are
`{ "error": "..." }`.

- `orca-wt info <folder>` → `{ worktree, primary, linked: bool }` where
  `worktree` = `git rev-parse --show-toplevel`, `primary` = parent of
  `git rev-parse --path-format=absolute --git-common-dir`, `linked` =
  `--git-dir` ≠ `--git-common-dir`.
- `orca-wt setup <worktree>` → refuses unless linked and **fresh**; then
  links, copies, writes the runner; returns `{ linked, copied, skipped,
  runner: <path> | null }`. Marks the worktree done (below).
- `orca-wt preflight <worktree>` → `{ ours: [abs paths], dirty: [porcelain
  lines minus ours], archive: bool }`.
- `orca-wt archive <worktree>` → runs `scripts.archive` from the primary's
  `orca.yaml` with `bash -e -c`, cwd = worktree, `ORCA_*` env; returns
  `{ code, output }` (output capped to the last 200 lines).
- `orca-wt remove <worktree> [--force]` → unlinks `ours`, then
  `git -C <primary> worktree remove [--force] <worktree>`; returns
  `{ ok, error? }`.

### Config reading (unchanged from the TUI spec, mirrors Orca)

- Parse with `yaml` (`uniqueKeys: true`, `maxAliasCount: 100`); reject the
  whole file on invalid YAML, duplicate key, non-mapping root, > 262,144 bytes.
- Field wrong type or > 65,536 bytes → dropped; strings trimmed, empty dropped.
- `worktree.sharedDirectories`: first 100 entries; normalize `\`→`/`, strip
  leading `./` and trailing `/`, dedupe; reject absolute, drive-prefixed,
  empty segment, `.`/`..`, any `.git` segment.
- `.worktreeinclude`: regular file ≤ 262,144 bytes, literal paths, `#`/blank
  ignored, skip `*`, `?`, leading `!`; same normalization; ≤ 1,000 candidates.
- `scripts.setup` from the **worktree's** `orca.yaml`; `sharedDirectories`,
  `.worktreeinclude` and `scripts.archive` from the **primary checkout**.

### Setup once, only for new worktrees

"Fresh" = the worktree's git admin dir (`git rev-parse --git-dir`, i.e.
`<primary>/.git/worktrees/<name>`) was created less than **10 minutes** ago
(`birthtime`, falling back to `ctime`) **and** has no `orca-setup-done` file.
`setup` writes `<git-dir>/orca-setup-done` before linking, so a second call
(two app windows, a mod reload) is a no-op. Old worktrees and Open worktree on
an existing checkout are never fresh. Git deletes the admin dir on removal, so
nothing is left behind.

### Link, copy, runner (unchanged semantics)

- Shared: source must exist in primary, be a directory, be ignored
  (`git check-ignore -q`); destination must not exist (`lstat`);
  `fs.symlinkSync(absSource, dest, "dir")`.
- Copies: same checks (files or dirs), `cp -cRH` on macOS falling back to
  `cp -RH`. `-H` copies a top-level symlink's target, as Orca does.
- Runner at `~/.local/state/orca-worktrees/runs/<name>-<ts>.sh`, mode 0700:
  `#!/usr/bin/env bash`, `set -e`, replayed shebang options, `trap 'rm -f
  "$0"' EXIT`, `export ORCA_ROOT_PATH ORCA_WORKTREE_PATH ORCA_WORKSPACE_NAME
  CONDUCTOR_ROOT_PATH GHOSTX_ROOT_PATH` (single-quoted), `cd` worktree, body.

### `orca-setup` mod (status strip + watcher)

- **Never edit shipped files.** Herdr's layouts and mods are read-only
  (an edited `layouts/main.json` is moved to `main-edited` on the next start)
  and any edit to `keys.json` freezes the person's shortcuts. So: no layout
  edits, no `keys.json` edits.
- Docked by its own `mod.json`: `{ "place": "bottom", "size": 28, "title":
  "Orca" }`. Herdr docks it into the shown layout the first time it sees the
  folder, and keeps that spot across restarts (layout clicks). User decision:
  a visible thin strip rather than a cloned layout.
- Strip contents, one row, `theme()` colours: `orca` label; last status
  (`setting up <name>…`, `<name>: 2 linked, 1 copied`, or the error in the
  error colour; empty when idle); and, when the focused space
  (`focused().space` is its id string) is a linked worktree, a **Remove**
  button that runs `openOverlay({ mod: "orca-remove", kind: "dialog", width:
  560, props: { space: <id> } })`, so the dialog is pinned to that space even
  if focus moves. Linked-ness per space id is
  cached from `info` calls (one `exec` per space folder, re-checked only when
  the folder changes).
- Watching: diff in `render()` and also every **3000 ms** via
  `cx.timer.every` (compares `spaces()` ids only, no `exec`), because the docs
  don't promise a redraw for a copy that isn't on screen.
- Diffs `spaces()` ids against ids seen by this copy. On first
  render it records all current ids without acting. For each newly seen
  local space (`machine === null`, non-empty `folder`), `cx.spawn` →
  `exec(node, [cli, "info", folder])`; if `linked`, `exec(node, [cli, "setup",
  worktree], { timeout: 600000 })`.
- If `runner` is non-null: `run("tab.new", { space: id, name: "Setup",
  folder: worktree, argv: ["bash", runner], focus: false })`.
- `notify({ title: "Orca setup", body: "<n> linked, <m> copied, <k>
  skipped" })` when anything happened; on `error`, `level: "error"` with the
  message. Silent when there was nothing to do.
- No animation timers; spinners use `.frames(...)` if any.

### `orca-remove` mod (dialog)

Opened by the strip's **Remove** button with `props.space`. No key binding.

Rule: **nothing changes until the last click.**

1. Target = `spaces().find(s => s.id === props().space)`; `info` on its folder. Not linked → show "This
   space is not a linked worktree." and a Close button.
2. `preflight`. Show the worktree path, branch, and if `dirty` is non-empty
   the list plus a red **Force remove** button; otherwise **Remove**. Cancel
   always present.
3. On click: if `archive`, run `archive`; non-zero `code` → show `output` and
   **Remove anyway** / Cancel.
4. `remove` (with `--force` only after Force remove); on `ok`,
   `run("space.close", { id, confirmed: true })` and close the dialog; else
   show `error`.

Only symlinks whose real path is inside the primary checkout are ever
deleted, with `unlink` (never recursive).

### Testing

- `node --test` for the helper: config parsing cases; link/copy/skip on a
  temp repo whose path contains a space; real dir at a shared path never
  replaced or deleted; freshness (fresh → runs once; second call no-op;
  admin dir older than 10 min → refused); preflight ignores only our
  symlinks; archive non-zero code reported; remove with/without `--force`.
- `herdr-app check` on both mods.
- Manual in Herdr.app on a scratch repo (`orca.yaml` with `setup: echo
  setup-ran`, `archive: echo archived`, `sharedDirectories: [node_modules]`,
  `.worktreeinclude` with `.env`): New worktree from the space menu → toast,
  symlink, `.env`, Setup tab shows `setup-ran`; Open worktree on an old
  checkout → nothing happens; strip's Remove → `archived`, checkout gone,
  space closed, branch kept. Quit and relaunch Herdr.app → strip still docked,
  no `main-edited` toast.

## Left to the builder

- Whether Herdr follows a symlinked mod folder (else copy in `install.sh`).
- Where `place: "bottom"` actually docks the strip; any edge is acceptable.
