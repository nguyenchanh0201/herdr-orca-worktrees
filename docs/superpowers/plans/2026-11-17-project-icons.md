# Project Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects in the sidebar get an icon (custom, then repo file, then GitHub avatar, then coloured letter), can be renamed and have their icon changed from the right-click menu, worktree rows drop the person's `<login>/` branch prefix, and `+` shows only on hover.

**Architecture:** The Node CLI (`src/projects.js`, `bin/orca-wt.js`) does all IO. It reads the repo, fetches the avatar, copies files into `<herdr home>/data/project-icons/`, and stores `name` and `icon` in `projects.json`. The mods only draw. Letter, colour and branch stripping are pure functions in `mods/projects/group.js`.

**Tech Stack:** Node 24 (`fetch`, `node:test`), the `yaml` dependency already in the repo, and Herdr.app mods (`gpui-kit`, `gpui-base`, `herdr`).

**Spec:** `docs/superpowers/specs/2026-11-17-project-icons-design.md`

## Global Constraints

- Herdr home is `process.env.HERDR_APP_HOME || ~/.config/herdr-app`. Icon files go in `<home>/data/project-icons/<sha1(path)>-<Date.now()>.<ext>`. `projects.json` stores the path relative to home (`data/project-icons/…`).
- Images: at most 256 KB (262144 bytes), and the magic bytes must match. Custom icons accept PNG, JPEG or WebP; avatars accept PNG or JPEG. The avatar fetch has a 10 s timeout.
- Repo icon candidates, in order: `favicon`, `public/favicon`, `app/favicon`, `app/icon`, `src/favicon`, `src/app/icon`, `assets/favicon`, `assets/icon`, `static/favicon`, `logo`, `public/logo`, `public/icon`, `src-tauri/icons/icon`, `app-icon`, `icon`, each with `.png` then `.webp`.
- GitHub avatar URL: `https://github.com/<owner>.png?size=64`. Skip it when two or more saved projects share the owner (case-insensitive).
- A failed download saves **no** `icon`, so the next start retries. A deliberate letter, or "no repo file and no usable owner", saves `{ source: "letter" }`.
- Never write into a repo, never fetch during render, and never let a bad icon break the sidebar: on any problem, show the letter.
- Rename and Change icon apply only to saved projects. `rename` and `set-icon` return `{ error }` for an unsaved path.
- Commits: no AI co-author trailer.

## Review Focus

- A project saved earlier with a `github` icon, and a second project with the same owner added later: the earlier one keeps its avatar. That's acceptable; the person can change it. Task 2 tests that `resolveIcons` only touches projects that have no `icon`.
- `projects.json` from before this change (entries with `{ path }` only) must still load and list. Covered in Task 1's `listProjects` test.
- An ssh host-alias remote (`git@github-nguyenchanh0201:owner/repo.git`) and an https remote with no `.git`. Covered in Task 1's `ownerFromRemote` tests.
- An icon file deleted from disk after it was saved: the sidebar must show the letter, not an empty box. Task 1 makes `listProjects` return `icon: null` when the file is missing.
- A branch that is exactly a login with no `/`, or `feat/<login>/x`: leave it unchanged. Covered in Task 3's `stripLogin` tests.

---

### Task 1: Project data (name, icon, logins) and pure helpers

**Files:**
- Modify: `src/projects.js`, `bin/orca-wt.js` (`handleProjects`)
- Test: `test/project-icons.test.js` (new)

**Interfaces:**
- Produces, exported from `src/projects.js`:
  - `herdrHome(): string`
  - `ownerFromRemote(url: string): string | null`: works for `git@github.com:O/R.git`, `https://github.com/O/R(.git)`, `git@github-alias:O/R.git` and `ssh://git@github.com/O/R.git`. Returns `null` for a host that isn't GitHub, or an empty or invalid URL. Any host that starts with `github` counts.
  - `sniffImage(buf: Buffer): "png" | "jpeg" | "webp" | null`
  - `REPO_ICON_CANDIDATES: string[]` (30 entries, in the order given above)
  - `listProjects()`: each entry is `{ path, exists, name: string | null, icon: string | null }`. `icon` is `entry.icon.file` when that file exists under `herdrHome()`, otherwise `null`. `icon` is also `null` for the `letter` source and for unresolved entries. Add `iconSource: string | null` (the stored source, or `null` when unresolved).
  - `renameProject(path, name?): { path, name } | { error }`: trims the name; an empty name deletes the `name` field.
  - `githubLogins(): string[]`: reads `~/.config/gh/hosts.yml` (honour `GH_CONFIG_DIR`) with `yaml`, and returns the keys under each host's `users`, plus each host's `user`, deduplicated. Returns `[]` on any error.
- CLI: `projects rename <path> [name]` and `projects logins` (prints `{ logins: [...] }`).

- [ ] **Step 1: Write the failing tests** in `test/project-icons.test.js`. Use `ORCA_WT_STATE_DIR`, `HERDR_APP_HOME` and `GH_CONFIG_DIR` pointed at temp folders, the same way `test/projects.test.js` sets up state.

```js
test("ownerFromRemote", () => {
  assert.equal(ownerFromRemote("git@github.com:CODUCT/Coduct.CTM.Server.git"), "CODUCT");
  assert.equal(ownerFromRemote("https://github.com/punarinta/make-slack-great-again.git"), "punarinta");
  assert.equal(ownerFromRemote("https://github.com/qnguyen3/zalo-swift-re"), "qnguyen3");
  assert.equal(ownerFromRemote("git@github-nguyenchanh0201:nguyenchanh0201/vietqr-node.git"), "nguyenchanh0201");
  assert.equal(ownerFromRemote("ssh://git@github.com/O/R.git"), "O");
  assert.equal(ownerFromRemote("git@gitlab.com:o/r.git"), null);
  assert.equal(ownerFromRemote(""), null);
});

test("sniffImage", () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBP")), "webp");
  assert.equal(sniffImage(Buffer.from("<svg")), null);
});

test("REPO_ICON_CANDIDATES order", () => {
  assert.equal(REPO_ICON_CANDIDATES.length, 30);
  assert.deepEqual(REPO_ICON_CANDIDATES.slice(0, 3), ["favicon.png", "favicon.webp", "public/favicon.png"]);
  assert.equal(REPO_ICON_CANDIDATES.at(-1), "icon.webp");
});

test("listProjects reads old entries and reports name/icon", () => {
  // projects.json: [{path: A}, {path: B, name: "Admin", icon: {source: "github", file: "data/project-icons/x.png"}},
  //                 {path: C, icon: {source: "letter"}}, {path: D, icon: {source: "repo", file: "data/project-icons/gone.png"}}]
  // with <home>/data/project-icons/x.png present and gone.png absent
  // expect: A {name: null, icon: null, iconSource: null}
  //         B {name: "Admin", icon: "data/project-icons/x.png", iconSource: "github"}
  //         C {icon: null, iconSource: "letter"}
  //         D {icon: null, iconSource: "repo"}
});

test("renameProject sets, trims, clears; unsaved path errors", () => {
  // rename(A, "  Admin Portal ") -> name "Admin Portal" saved; rename(A, "") -> no name field;
  // rename("/not/saved", "x") -> { error }
});

test("githubLogins reads hosts.yml users", () => {
  // hosts.yml: "github.com:\n    users:\n        jimmy-nguyen-codeleap:\n        nguyenchanh0201:\n    user: jimmy-nguyen-codeleap\n"
  // -> ["jimmy-nguyen-codeleap", "nguyenchanh0201"]; missing file -> []
});
```

Write the commented tests as real assertions on the values shown. Also add one CLI test: `node bin/orca-wt.js projects logins` prints JSON with a `logins` array.

- [ ] **Step 2: Run them**: `node --test test/project-icons.test.js`. Expected: FAIL, because the exports don't exist.
- [ ] **Step 3: Implement** the exports above, and wire `rename` and `logins` into `handleProjects` (`rename` gets `rest[0]` as the path and `rest.slice(1).join(" ")` as the name). Keep `writeProjectsAtomic`, and keep every other field of an entry when rewriting it.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass, including the existing `test/projects.test.js` (adjust its `listProjects` deep-equals for the new fields).
- [ ] **Step 5: Commit**: `git add src/projects.js bin/orca-wt.js test/project-icons.test.js test/projects.test.js && git commit -m "feat: project names, icon fields and gh logins in orca-wt"`

### Task 2: Icon resolution and set-icon

**Files:**
- Modify: `src/projects.js`, `bin/orca-wt.js`
- Test: `test/project-icons.test.js`

**Interfaces:**
- Consumes: Task 1's helpers and `listProjects`.
- Produces:
  - `async resolveIcons({ fetchImpl = fetch } = {}): { projects }`. For each saved entry with no `icon`, in parallel: try the repo candidates (the first file that exists, at most 262144 bytes, with a valid `sniffImage`, wins, saved as `repo`). Then try the owner avatar (only if the owner is shared by no other saved project). The owner comes from `git -C <path> remote get-url origin`. Fetch with `AbortSignal.timeout(10000)`; the response must be `ok`, at most 262144 bytes, and `png` or `jpeg`; save it as `github`. If the fetch fails, leave `icon` absent. If no source applies, save `{ source: "letter" }`. Returns `listProjects()`.
  - `async setIcon(path, source, value?, { fetchImpl } = {}): { path, icon } | { error }`. `source` is one of `repo | github | letter | custom`. `repo` and `github` ignore the shared-owner rule (the person asked for it). `custom` with a value that starts with `http://` or `https://` fetches it; otherwise it's a file path, where `~` expands. Unsaved path, unknown source, too big, not an image, or a failed fetch → `{ error }`, and the stored icon stays unchanged.
  - Writing an icon: `<home>/data/project-icons/<sha1(path)>-<Date.now()>.<ext>` (temp file, then rename; `mkdir -p`). Then delete the entry's previous `icon.file`, if any.
- CLI: `projects resolve-icons` and `projects set-icon <path> <source> [value]`.

- [ ] **Step 1: Write the failing tests** (use `makeRepo` from `test/helpers/repo` for real git repos, with `git remote add origin …`; use a fake `fetchImpl` that returns `new Response(pngBytes)` or throws):
  - `resolveIcons prefers a repo icon`: the repo has `public/logo.png` (a valid PNG of 8 bytes or more) → `iconSource` is `"repo"`, and the file exists under the herdr home.
  - `resolveIcons uses the avatar for a unique owner`: origin is `git@github.com:solo/x.git` → `fetchImpl` is called with `https://github.com/solo.png?size=64`, and `iconSource` is `"github"`.
  - `resolveIcons skips a shared owner`: two saved repos with origin owner `CODUCT` and `coduct` → `fetchImpl` is never called, and both have `iconSource` `"letter"`.
  - `resolveIcons leaves icon unset when the fetch fails`: `fetchImpl` throws → `iconSource` is `null`. Run it again with a working fetch → `"github"`.
  - `resolveIcons stores letter with no remote and no file`.
  - `resolveIcons does not touch resolved entries`: an entry with `{ source: "letter" }` stays as it is, and `fetchImpl` is not called.
  - `resolveIcons rejects a non-image avatar`: the fetch returns `"<html>"` → `iconSource` is `null`.
  - `setIcon custom from file replaces the old file`: set it twice; only the second file exists, and the two names differ.
  - `setIcon letter`, `setIcon on an unsaved path errors`, `setIcon custom with a 300 KB file errors and keeps the old icon`.
- [ ] **Step 2: Run them**: `node --test test/project-icons.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `resolveIcons` and `setIcon` and wire the two CLI subcommands. The CLI awaits them. Check how `bin/orca-wt.js` already handles async commands (`usage`) and follow that.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git add src/projects.js bin/orca-wt.js test/project-icons.test.js && git commit -m "feat: resolve and set project icons in orca-wt"`

### Task 3: Sidebar helpers in group.js

**Files:**
- Modify: `mods/projects/group.js`
- Test: `test/projects-group.test.js`

**Interfaces:**
- Produces (ESM exports from `group.js`, no imports):
  - `letterOf(name: string): string`: the first letter or digit of the last `.`-separated non-empty part, upper-cased. Falls back to the first letter of the whole name, then `"?"`.
  - `colorIndex(path: string, n: number): number`: a stable string hash modulo `n`.
  - `stripLogin(branch: string, logins: string[]): string`: if `branch` starts with `<login>/`, where the login matches case-insensitively and the rest is not empty, drop that prefix. Otherwise return `branch` unchanged.
  - `label(input, logins = [])`: applies `stripLogin` wherever it returns a branch (live `s.branch` and sleeping `input.sleeping.branch`). It never touches a name the person set on purpose (`named`).
  - `group(...)`: in `opts.saved`, entries may now carry `name`, `icon` and `iconSource`. A repo group whose key is saved gets `g.displayName = saved.name || g.name` and `g.icon = saved.icon ?? null`. Unsaved groups get `g.displayName = g.name` and `g.icon = null`. Keep `savedByPath` keyed as today and store the whole saved entry.

- [ ] **Step 1: Write the failing tests**:

```js
test("letterOf", () => {
  assert.equal(letterOf("Coduct.CTM.AdminPortal"), "A");
  assert.equal(letterOf("Coduct.CTM.UserApp"), "U");
  assert.equal(letterOf("herdr-orca-worktrees"), "H");
  assert.equal(letterOf("x."), "X");
  assert.equal(letterOf(""), "?");
});
test("colorIndex is stable and in range", () => {
  const a = colorIndex("/a/Coduct.CTM.Server", 8);
  assert.equal(a, colorIndex("/a/Coduct.CTM.Server", 8));
  assert.ok(a >= 0 && a < 8);
});
test("stripLogin", () => {
  const L = ["jimmy-nguyen-codeleap", "nguyenchanh0201"];
  assert.equal(stripLogin("nguyenchanh0201/feat-CTMN-197-add-comments", L), "feat-CTMN-197-add-comments");
  assert.equal(stripLogin("NguyenChanh0201/x", L), "x");
  assert.equal(stripLogin("feat/CTMN-199/manage", L), "feat/CTMN-199/manage");
  assert.equal(stripLogin("feat/nguyenchanh0201/x", L), "feat/nguyenchanh0201/x");
  assert.equal(stripLogin("nguyenchanh0201", L), "nguyenchanh0201");
  assert.equal(stripLogin("nguyenchanh0201/", L), "nguyenchanh0201/");
});
test("label strips login from branch, not from a set name", () => {
  const L = ["nguyenchanh0201"];
  assert.equal(label({ branch: "nguyenchanh0201/explore", name: "x", named: false }, L), "explore");
  assert.equal(label({ branch: "nguyenchanh0201/explore", name: "Mine", named: true }, L), "Mine");
  assert.equal(label({ space: null, sleeping: { branch: "nguyenchanh0201/a" }, worktree: "/w/a" }, L), "a");
});
test("group carries saved name and icon", () => {
  // build one repo group whose primary is saved as {path, exists: true, name: "Admin", icon: "data/project-icons/x.png"}
  // -> g.displayName === "Admin", g.icon === "data/project-icons/x.png"; an unsaved repo group -> displayName === name, icon === null
});
```

Write the last one with the fixtures the existing `group` tests in that file use.

- [ ] **Step 2: Run them**: `node --test test/projects-group.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and the `group`/`label` changes in `mods/projects/group.js`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git add mods/projects/group.js test/projects-group.test.js && git commit -m "feat: letter, colour and login stripping helpers for the sidebar"`

### Task 4: Sidebar draws icons, names, hover +, clean labels

**Files:**
- Modify: `mods/projects/main.js`

**Interfaces:**
- Consumes: CLI `projects list` (Task 1 shape), `projects resolve-icons`, `projects logins`, and `letterOf`, `colorIndex`, `label(row, logins)`, `g.displayName` and `g.icon` from Task 3.

- [ ] **Step 1: State.** In `init`: `this.logins = []`, `this.resolvedOnce = false`, `this.hoverHeader = null`. Load `projects logins` once (`this.cli(["projects", "logins"])`, keep `r.logins` if it's an array, then notify).
- [ ] **Step 2: Resolve once.** After `loadSaved` sets `this.saved`, if `!this.resolvedOnce` and any entry has `iconSource === null`: set `this.resolvedOnce = true`, run `this.cli(["projects", "resolve-icons"], 60000)`, set `this.saved` from its `projects` when that's an array, then notify. In the add-project request handler (around line 535), after a successful `projects add`, run `resolve-icons` the same way, without the once guard.
- [ ] **Step 3: Header** (`renderHeader`, around line 1018), for repo groups:
  - Insert the icon between the chevron and the name: `image(g.icon).size(16).rounded(3).flex_none()` when `g.icon`. Otherwise a 16×16 `rounded(3)` box with `bg(PALETTE[colorIndex(g.key, PALETTE.length)])`, centred, holding `letterOf(g.displayName)` in `text_size(10)`, `font_bold`, white.
  - `PALETTE`: a module constant of 8 hex colours readable under white text (for example `#c2410c #b45309 #4d7c0f #047857 #0e7490 #1d4ed8 #6d28d9 #be185d`).
  - Name: `g.displayName`.
  - `+`: draw it only when `this.hoverHeader === g.key`. Add `.on_hover((h, cx) => { const k = h ? g.key : (this.hoverHeader === g.key ? null : this.hoverHeader); if (k !== this.hoverHeader) { this.hoverHeader = k; cx.notify(); } })` on the header row. The `+` is a child of the row, so hovering it keeps the row hovered.
  - Import `image` from `gpui-kit`.
- [ ] **Step 4: Labels.** Pass `this.logins` to every `label(...)` call (lines around 935, 947 and 1143).
- [ ] **Step 5: Check it**: `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects && npm test`. Expected: no errors, all pass.
- [ ] **Step 6: Look at it.** After the sidebar restarts (re-install), `herdr-app shot <scratch>/s.png` and read the image. Expected:
  - The Coduct projects show U, S and A badges in different colours.
  - make-slack-great-again shows the punarinta avatar.
  - herdr-orca-worktrees shows an H badge.
  - The rows read `feat-CTMN-197-add-comments` and `explore`.
  - No `+` shows unless you hover.
- [ ] **Step 7: Commit**: `git add mods/projects/main.js && git commit -m "feat: project icons, display names and hover + in the sidebar"`

### Task 5: Rename… and Change icon… in the project menu

**Files:**
- Modify: `mods/orca-project/main.js`, `mods/projects/main.js` (the header right-click `openOverlay` height and props)

**Interfaces:**
- Consumes: CLI `projects rename` and `projects set-icon` (Tasks 1 and 2).
- Produces: `orca-project` modes `rename` (props `{ path, name }`) and `icon` (props `{ path }`).

- [ ] **Step 1: Menu.** In `projects` header right-click: `height: 80` becomes `150`, and add `name: g.displayName` to the props. In `orca-project` `renderHeader`, when `p.saved`, put two `popupRow`s above "Remove from sidebar":
  - `Rename…` → `this.close()`, then `openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 160, props: { mode: "rename", path: p.path, name: p.name } })`.
  - `Change icon…` → `this.close()`, then `openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 260, props: { mode: "icon", path: p.path } })`.
- [ ] **Step 2: Rename dialog** (`renderRename`). Follow how the `clone` mode builds its `InputState` and `Input` (same file). The title is "Rename project". The input is prefilled with `p.name`. Enter or a Save button runs `exec(config.node, [config.cli, "projects", "rename", p.path, value])`. On `{ error }`, show it in `t.blocked` and stay open. Otherwise `setShared("orca.projects.rev", Date.now())` and close. Esc closes. Add a hint line: "Leave empty to use the folder name".
- [ ] **Step 3: Icon dialog** (`renderIcon`): title "Project icon", then `popupRow`s **GitHub avatar** (`github`), **Icon from repo** (`repo`) and **Letter** (`letter`). Each runs `projects set-icon <path> <source>` with a 30000 ms timeout. Then **Custom…**: an `Input` (placeholder "Path or URL to a PNG, JPEG or WebP, up to 256 KB") with an Apply button that runs `set-icon <path> custom <value>`. Same error and success handling as Rename. While a call runs, show "Working…" and ignore further clicks.
- [ ] **Step 4: Check it**: `bash scripts/install.sh projects orca-project && herdr-app check ~/.config/herdr-app/mods/orca-project && herdr-app check ~/.config/herdr-app/mods/projects && npm test`. Expected: no errors, all pass.
- [ ] **Step 5: Manual checks** (ask the person):
  1. Right-click Coduct.CTM.AdminPortal → Rename… → "Admin Portal" → the header reads "Admin Portal" with an A badge. Rename to empty → back to the folder name.
  2. Change icon… → GitHub avatar on Coduct.CTM.Server → the CODUCT logo appears. Letter → back to S.
  3. Custom… with a bad path → an inline error, and the dialog stays open.
  4. Right-click an unsaved repo group → only the "Not saved" note, no Rename or Change icon.
- [ ] **Step 6: Commit**: `git add mods/orca-project/main.js mods/projects/main.js && git commit -m "feat: rename and change icon from the project menu"`
