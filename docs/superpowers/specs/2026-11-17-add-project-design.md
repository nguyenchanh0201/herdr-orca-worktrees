# Add project (folder or git clone) — design (Herdr.app)

Date: 2026-11-17. Builds on the projects sidebar
(`2026-11-16-projects-sidebar-design.md`) and the agent picker
(`2026-11-17-worktree-agent-picker-design.md`).

## Intent

Like Orca's "Add a project": the person adds a repo to the projects sidebar
either by choosing a local folder or by cloning a Git URL. Adding only makes
the project **wait in the sidebar** — a header with its `+` and no spaces under
it — so they can start worktrees from `+` later. Nothing opens.

Today a project header exists only while one of its spaces is open; closing
the last space makes it disappear. So this also introduces a saved project
list.

## Goals

1. A saved project list; every saved project shows a header (with `+`) even
   with no open spaces.
2. "Add project" at the bottom of the sidebar → popup: **Choose folder…**
   (system folder picker, no dialog) and **Clone from URL…** (dialog).
3. Clone dialog: **Git URL**, **Parent folder**, folder name auto-filled from
   the URL (editable); "Cloning…" while it runs; errors shown in the dialog.
4. Right-click a project header → **Remove from sidebar** (never touches disk).
5. First run seeds the list with every repo that currently has an open space,
   so nothing visible today disappears when its spaces close.

## Non-goals

- Orca's parent-folder scan, "create new project", SSH/remote hosts, the
  default-branch / "Project added" step, "Open as Folder" for non-git folders,
  importing Orca's own project list, reordering projects by drag.

## Anti-goals

- Deleting or moving anything on disk (remove = forget only).
- A clone that hangs forever on a password or host-key prompt.
- Overwriting an existing folder when cloning.
- Editing shipped mods or `layouts/main.json`.

## Constraints

- Same as the base designs: mods are gpui-kit JS without Node; file and git
  work goes through `bin/orca-wt.js` (one JSON object on stdout, exit 0,
  failures `{ "error": "..." }`), tested with `node --test`;
  `herdr-app check` passes for every mod; `init()` returns early when
  `checking()`.
- `exec` timeout max 600,000 ms.
- `pickFolder({ prompt })` is local only and resolves a path or null.

## Approaches considered

| Decision | Picked | Alternative |
|---|---|---|
| Where the list lives | **File** `~/.local/state/orca-worktrees/projects.json` via `orca-wt projects …` — testable, inspectable, survives a Herdr reset | `setShared` in Herdr's `shared.json` — no helper code, but Herdr-owned and wiped by a reset |
| How to add | **"Add project" row → popup**: Choose folder… (picker directly), Clone from URL… (dialog) | One Orca-style dialog with both — an extra screen for the folder case |
| Existing projects | **Seed once** from repos with open spaces | Start empty; or import Orca's list |

The person approved all three picks and the defaults below.

## Design

### Data: `projects.json`

`~/.local/state/orca-worktrees/projects.json` (directory created on first
write; the state dir already holds `runs/`):

```json
{ "version": 1, "projects": [ { "path": "/Users/…/jimmy_dev/mottanrung-mono" } ] }
```

- `path` is the repo's **main checkout**, the same `primary` that
  `orca-wt info` returns and that keys sidebar groups. Stored as
  `fs.realpathSync` of it; de-duplicated on that.
- Order = order added (seed: the sidebar's current group order).
- Written atomically (write `projects.json.tmp`, rename).
- Unreadable / invalid JSON → `list` returns `{ error }` and the sidebar
  behaves as today (groups from open spaces only); nothing overwrites the bad
  file except an explicit add/remove/seed, which first moves it aside to
  `projects.json.bad-<epoch ms>`.

### Helper: new `orca-wt` commands (`src/projects.js`, wired in `bin/orca-wt.js`)

- `orca-wt projects list` → `{ projects: [{ path, exists }] }`; `exists` =
  the folder is still there. Missing file → `{ projects: [], seeded: false }`;
  present → `seeded: true`.
- `orca-wt projects add <folder>` → resolves with `gitInfo(folder)`; not a git
  repo → `{ error: "Not a git repository" }`; else stores its `primary`
  (adding a linked worktree adds its main repo). Already there → no change.
  Returns `{ path, added: bool }`.
- `orca-wt projects remove <path>` → forgets it; `{ removed: bool }`.
- `orca-wt projects seed <path>...` → only if the file does **not** exist:
  writes those paths (each resolved like `add`, non-git skipped); else no-op.
  Returns `{ seeded: bool, projects: [...] }`.
- `orca-wt clone <url> <parent> <name>` →
  - `name` must be one path segment (no `/`, not `.`/`..`, non-empty);
    `parent` must be an existing directory; `<parent>/<name>` must not exist
    (`{ error: "<path> already exists" }`).
  - Runs `git clone -- <url> <parent>/<name>` with
    `GIT_TERMINAL_PROMPT=0` and
    `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (fail instead of prompting),
    `timeout` 590 s (under `exec`'s 600 s cap).
  - Failure → `{ error: <last 20 lines of stderr> }`; git cleans up its
    partial folder on failure.
  - Success → adds it to the list (as `add`) and returns `{ path }`.
- `defaultCloneName(url)` (pure, exported for tests): last path segment of the
  URL (`https`, `ssh://`, and scp-style `git@host:owner/repo.git`), minus a
  trailing `.git` and `/`.

### Sidebar (`mods/projects`)

- **List load.** In `init` and whenever `shared("orca.projects.rev")`
  changes (checked in the 500 ms `check()`), `cx.spawn` → `orca-wt projects
  list`; keep `this.saved = [{ path, exists }]`. Errors → `this.saved = []`.
- **Seed.** When the list says `seeded: false` and the first round of probes
  is done (the existing 3 s loading window has ended), call `orca-wt projects
  seed <every repo group's primary, in group order>` once, then reload.
- **Grouping.** `group()` gets an optional `opts.saved` (array of paths): each
  saved path that has no group this round gets an empty repo group
  `{ key: path, name: basename, kind: "repo", primary: path,
  primarySpace: null, rows: [], saved: true }`. Order: groups that have spaces
  (today's rule), then saved-only groups in saved order, then Other last.
  Groups with spaces whose key is saved also get `saved: true`.
- **Header.** Saved-only headers show count `0` and `+` as usual. A saved
  project whose folder is gone (`exists: false`) shows its name in `dim` with
  "missing", **no** `+`.
- **Header right-click** (repo groups only) → `openOverlay({ mod:
  "orca-project", kind: "popup", width: 220, height: 80, props: { mode:
  "header", path: g.primary, saved: Boolean(g.saved) } })`.
- **"Add project" row**: fixed below the scrolling list (not inside it),
  28 px, `+ Add project` in `muted`, hover `hover`; click →
  `openOverlay({ mod: "orca-project", kind: "popup", width: 220, height: 90,
  props: { mode: "add" } })`.

### Who runs the slow work: the sidebar, not the popup/dialog

Closing an overlay cancels its mod's unfinished tasks after 250 ms (Herdr
AGENTS.md, "Cleanup"), and Esc always closes the top dialog. So a popup that
awaits `pickFolder`, or a dialog that awaits a clone, loses the result when it
closes. The `projects` sidebar copy lives as long as the layout (also while
the sidebar is hidden), so it owns both:

- Overlays send a **request** with `setShared("orca.projects.request", { id:
  Date.now(), kind: "pick" } | { id, kind: "clone", url, parent, name })` and
  may close at once.
- `projects`' 500 ms `check()` sees a request id it hasn't handled, records
  it as handled, and `cx.spawn`s the work:
  - `pick` → `pickFolder({ prompt: "Add project" })` → `orca-wt projects add`.
  - `clone` → `orca-wt clone url parent name` (`timeout: 600000`).
- Progress/result for the dialog: `setShared("orca.projects.clone", { id,
  state: "running" | "done" | "error", error? })`.
- Every outcome also toasts: success `notify({ title: "Project added", body:
  <name> })`; error `notify({ title: "Add project" | "Clone failed", body:
  error, level: "error" })`. Then `setShared("orca.projects.rev",
  Date.now())` and reload the list.
- **Esc during "Cloning…"** just dismisses the dialog: the clone keeps going
  in the sidebar and its toast reports the result (person's call left to me:
  no cancel button — `exec` can't kill a process, and git removes its own
  partial folder on failure).

### New mod `mods/orca-project/` (`mod.json`: `{ "place": "none", "title": "Project" }`)

One mod, three modes from `props().mode`; draws nothing without
`props().overlay` (as `orca-new`).

- **`add`** (popup, styled like `orca-new`): rows **Choose folder…** and
  **Clone from URL…**.
  - Choose folder → send the `pick` request, close the popup (the sidebar
    opens the system picker; null → nothing).
  - Clone → close popup; `openOverlay({ mod: "orca-project", kind: "dialog",
    width: 520, height: 230, props: { mode: "clone" } })`.
- **`clone`** (dialog): title "Clone from URL"; inputs **Git URL** (focused)
  and **Parent folder** (default: `localStorage` `clone.parent`, else
  `<home()>/jimmy_dev` if it exists, else `home()`), with a **Choose…** button
  (`pickFolder`); a **Folder name** input auto-filled from
  `defaultCloneName(url)` as the URL changes until the person edits it;
  buttons **Clone** (Enter) and **Cancel** (Esc).
  - Clone → save `clone.parent`, send the `clone` request, disable inputs,
    label "Cloning…" while `shared("orca.projects.clone")` for that id is
    `running`; `error` → show it in the dialog (error colour, wrapped),
    inputs re-enabled; `done` → close. The toast comes from the sidebar.
  - Input widgets: follow the shipped `worktree` dialog (`InputState`,
    `Input` from `gpui-base`).
- **`header`** (popup): one row **Remove from sidebar** (only when
  `props().saved`; else a dim line "Not saved — it shows while its spaces are
  open"). Click → `orca-wt projects remove <path>` → bump
  `orca.projects.rev` → close. A removed project with open spaces stays
  visible until they close (it's no longer `saved`).

### Install

`scripts/install.sh` default list adds `orca-project`; it gets the generated
`config.js` (`{ node, cli }`) like the others.

## Testing

- `node --test` (`test/projects.test.js`, temp `HOME`/state dir via an env
  override `ORCA_WT_STATE_DIR` used only by tests):
  - list on missing file → `{ projects: [], seeded: false }`.
  - add a main checkout; add its linked worktree → one entry (the primary);
    add a non-git folder → `Not a git repository`.
  - remove; remove unknown → `removed: false`.
  - seed writes once; second seed no-op; seed after an add no-op.
  - invalid JSON → `list` errors; `add` moves it to `.bad-*` and writes fresh.
  - `exists: false` after the folder is deleted.
  - `defaultCloneName`: `https://github.com/a/b.git`, `https://github.com/a/b/`,
    `git@github.com:a/b.git`, `ssh://git@host/a/b` → `b`.
  - clone from a local bare repo (`file://` URL) into a temp parent → `{ path }`
    and it's in the list; existing destination → error; bad name (`a/b`,
    `..`) → error; bad URL → error, no folder left.
- `group()` tests: saved-only group appears after space groups, before Other;
  saved path that also has spaces isn't duplicated; missing saved project
  keeps its header.
- `herdr-app check` on `orca-project` and `projects`.
- Manual: Choose folder → a repo appears as a header with `0` and `+`; `+` →
  agent picker → worktree works; choose a non-git folder → error toast;
  Clone a small public repo → "Cloning…", then its header appears and the
  folder exists; clone into an existing folder name → error in dialog; a
  private repo without access fails fast (no hang); right-click → Remove from
  sidebar → header goes (folder still on disk); first run after install:
  CTM / mottanrung-mono stay after closing all their spaces.

## Review notes

Builder check (2026-11-17) raised two points, both settled above as my calls:
popup/dialog tasks die on close (so the sidebar runs pick and clone), and Esc
during a clone dismisses without cancelling (the toast reports the result).
Also for the builder: the sidebar's early "No spaces" return must still show
saved projects and the Add project row; `bin/orca-wt.js` currently reads one
positional argument, so `projects`/`clone` need their own argument parsing.

## Left to the builder

- Exact spacing and the "missing" styling within theme colours.
- Whether `ORCA_WT_STATE_DIR` also replaces the `runs/` state dir (fine
  either way, test-only).
