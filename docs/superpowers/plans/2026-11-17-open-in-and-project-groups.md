# "Open in" and Project Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Orca-style **Open in ›** (VS Code, Zed, … Finder, Customize apps…) and **Project Group ›** side menus to the projects sidebar, and add a group level above projects in the sidebar tree.

**Architecture:**
- The `orca-wt` CLI owns all file and process work:
  - `projects set-group` and a `group` field in `projects list`;
  - a new `src/apps.js` for `apps list`, `apps set` and `open`.
- `mods/projects/group.js` gets a pure `projectGroups` helper that orders and sorts sections. `mods/projects/main.js` renders the group headers and indents grouped projects.
- `mods/orca-project` gains the `›` menu rows, two side-popup modes (`open-in`, `group`) and two dialogs (`new-group`, `apps`).

**Tech Stack:** Herdr.app mods (gpui-kit, gpui-base, herdr), Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-open-in-and-project-groups-design.md`

## Global Constraints

- **App ids and names, in this order:**

  | id | Label | Opened with |
  |---|---|---|
  | `vscode` | VS Code | `Visual Studio Code` |
  | `zed` | Zed | `Zed` |
  | `cursor` | Cursor | `Cursor` |
  | `xcode` | Xcode | `Xcode` |
  | `terminal` | Terminal | `Terminal` |
  | `ghostty` | Ghostty | `Ghostty` |
  | `finder` | Finder | Finder |

- **Installed** means `<App>.app` exists in one of:
  - `/Applications`
  - `~/Applications`
  - `/System/Applications`
  - `/System/Applications/Utilities`

  Finder always counts as installed.
- **The default chosen set** is every installed app except `terminal` and `ghostty`.
- **`apps.json` lives in the CLI's state dir** (`ORCA_WT_STATE_DIR`, or `~/.local/state/orca-worktrees`). Its content is `{ "version": 1, "apps": [ids] }`.
- **Opening:** Finder runs `open <folder>`; every other app runs `open -a "<App name>" <folder>`. Errors go to `notify({ level: "error" })`.
- **The group is an optional `group: string` on a project entry in `projects.json`.**
  - Names are trimmed and matched case-insensitively.
  - When a name matches an existing group, the existing spelling is kept.
- **Group order is first appearance in `projects.json`.** `set-group` with a name no project has yet moves that entry to the end of the file.
- **Every write to `projects.json` passes whole entries,** so `name`, `icon` and `group` all survive.
- **Copy, exactly as written:**
  - Menu rows: `Open in`, `Project Group`, `Customize apps…`, `New group from project…`, `Remove from group`, and the heading `Move to group`.
  - The new-group dialog: title `New Project Group`; subtitle `Create a group and move this project into it.`; field label `Group Name`; default value `<display name> group`; buttons `Cancel` and `Create`.
  - The duplicate-name error: `A group with that name already exists — use Move to group`.
- **The fold key is `group:<lowercased name>`,** stored in the existing `projects.collapsed` localStorage list.
- **No network calls. No AI co-author trailer on commits.**

## Review Focus

1. **A project whose `group` names a group with different case or spaces** (`" ctm group"` vs `"CTM group"`) lands in one group, not two. Task 3 tests this in `projectGroups`, and Task 2 normalises it on write.
2. **Renaming or changing the icon of a grouped project keeps its `group`.** `renameProject` and `setIcon` rewrite the file. Task 2 adds a test that the group survives both.
3. **A folded group containing the active space** still shows that project's header and the active card. Task 4 has a harness test for this.
4. **Grouping a repo that isn't saved, or isn't a git repo:** the first is saved, then grouped. The second returns `{error}` and leaves `projects.json` unchanged. Task 2 tests both.
5. **A chosen app that is no longer installed** is hidden from `apps list` → `chosen`, and stays in `apps.json`. Task 1 tests this.

---

### Task 0: Check that popups stack (no commit)

**Files:** a throwaway edit to `~/.config/herdr-app/mods/orca-project/main.js` only (the installed copy). Reinstall afterwards.

- [ ] **Step 1:** In the installed `renderHeader`, add a temporary row whose `on_mouse_down("left")` calls `openOverlay({ mod: "orca-project", kind: "popup", frame: "none", width: 200, height: 120, at: { x: e.bounds.x + e.bounds.width + 4, y: e.bounds.y }, props: { mode: "header", path: props().path, name: "probe" } })`.
- [ ] **Step 2:** Right-click a project header, then click the row. Check that:
  - a second popup appears beside the first, with both visible;
  - Esc closes the top one;
  - clicking outside closes both.

  Take a screenshot with `herdr-app shot <scratchpad>/stack.png` and read it.
- [ ] **Step 3:** Record the result as one line under the "Decision" note at the end of this plan:
  - **Stacks:** Tasks 5–6 use side popups.
  - **Doesn't stack:** Tasks 5–6 use drill-down in place. The same `mode` values render inside the first popup, with a `‹ Back` row.
- [ ] **Step 4:** Restore the installed copy with `bash scripts/install.sh orca-project`.

### Task 1: Apps in the CLI

**Files:**
- Create: `src/apps.js`
- Modify: `bin/orca-wt.js` (add `case "apps"` and `case "open"`)
- Test: `test/apps.test.js`

**Interfaces:**
- **Produces** (CJS exports of `src/apps.js`):
  - `APPS`: the ordered table from Global Constraints, as `{ id, name, app }`.
  - `installedApps(dirs = DEFAULT_DIRS): {id, name}[]`, in `APPS` order.
  - `listApps({ dirs } = {}): { installed: {id, name}[], chosen: string[] }`. `chosen` is the saved ids (or the default set) filtered to installed ones, in `APPS` order.
  - `setApps(ids: string[]): { ok: true, apps: string[] } | { error }`. Unknown ids are dropped, and the file is written atomically (a temp file, then rename).
  - `openArgv(id: string, folder: string): string[] | null`: `["<folder>"]` for Finder, `["-a", "<App>", "<folder>"]` for the others, and `null` for an unknown id.
  - `openIn(id, folder): { ok: true } | { error }`. Returns an error if the folder is missing; otherwise runs `spawnSync("open", openArgv(...))` and returns its stderr as the error on a non-zero exit.
- **CLI:**
  - `orca-wt apps list`
  - `orca-wt apps set <ids...>`
  - `orca-wt open <id> <folder>`

  Each prints JSON, like the other subcommands.

- [ ] **Step 1: Write the failing tests** in `test/apps.test.js`. Use a temp `ORCA_WT_STATE_DIR` and a temp `dirs` holding fake `Visual Studio Code.app`, `Zed.app` and `Ghostty.app` folders:
  ```js
  test("installedApps finds .app folders and always Finder", () => {
    assert.deepEqual(apps.installedApps([tmpApps]).map((a) => a.id), ["vscode", "zed", "ghostty", "finder"]);
  });
  test("listApps defaults to installed minus terminal and ghostty", () => {
    assert.deepEqual(apps.listApps({ dirs: [tmpApps] }).chosen, ["vscode", "zed", "finder"]);
  });
  test("setApps saves known ids; listApps hides uninstalled but keeps them in the file", () => {
    assert.deepEqual(apps.setApps(["zed", "xcode", "bogus"]).apps, ["zed", "xcode"]);
    assert.deepEqual(apps.listApps({ dirs: [tmpApps] }).chosen, ["zed"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "apps.json"), "utf8")).apps, ["zed", "xcode"]);
  });
  test("openArgv", () => {
    assert.deepEqual(apps.openArgv("finder", "/x"), ["/x"]);
    assert.deepEqual(apps.openArgv("vscode", "/x"), ["-a", "Visual Studio Code", "/x"]);
    assert.equal(apps.openArgv("nope", "/x"), null);
  });
  test("openIn rejects a missing folder", () => {
    assert.ok(apps.openIn("finder", "/definitely/not/here").error);
  });
  ```
  Also add a CLI test, `orca-wt apps set zed`, then check that `apps list` returns JSON whose `chosen` is an array. Use the existing `spawnSync(CLI)` pattern from `test/cli.test.js`.
- [ ] **Step 2: Run** `node --test test/apps.test.js`. Expected: FAIL (cannot find module `../src/apps`).
- [ ] **Step 3: Implement** `src/apps.js` and the two `bin/orca-wt.js` cases. Reuse `stateDir` from `src/projects.js` by exporting it from there.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add src/apps.js src/projects.js bin/orca-wt.js test/apps.test.js && git commit -m "feat: apps list, choice and open in the orca-wt cli"`

### Task 2: Groups in the CLI

**Files:**
- Modify: `src/projects.js` (add `setGroup`; `listProjects` returns `group`)
- Modify: `bin/orca-wt.js` (`handleProjects`: `case "set-group"`)
- Test: `test/projects.test.js`

**Interfaces:**
- **Produces:**
  - `setGroup(targetPath: string, name?: string): { ok: true, path: string, group: string | null } | { error: string }`.
    - The name is trimmed. An empty or missing name removes the project from its group.
    - If the path isn't saved, it calls `addProject(targetPath)` first and passes its `error` through.
    - If the name case-insensitively matches another project's group, that spelling is used.
    - If no other project has the name, the entry moves to the end of the list.
  - `listProjects()` entries gain `group: string | null`.
- **CLI:** `orca-wt projects set-group <path> [name words...]`. The name is the remaining args joined by spaces, as `rename` does.

- [ ] **Step 1: Write the failing tests.** Use the existing `makeRepo` and temp-state helpers in `test/projects.test.js`:
  - **`set-group creates a group and moves the entry last`:** with repos A and B saved, `setGroup(A, "CTM group")`. `listProjects().projects` is ordered `[B, A]`, and A's `group` is `"CTM group"`.
  - **`set-group reuses an existing group's spelling and keeps order`:** with A in `"CTM group"`, `setGroup(B, "  ctm GROUP ")` returns `group: "CTM group"`, and the order is unchanged.
  - **`set-group with no name removes the group`:** `setGroup(A)` gives `group: null`, and the `group` key is gone from A's entry in the raw file.
  - **`set-group saves an unsaved repo`:** with C not saved, `setGroup(C, "X")` gives C in `listProjects()` with `group: "X"`.
  - **`set-group on a non-git folder errors and leaves the file alone`:** the raw `projects.json` is byte-identical before and after.
  - **`rename and set-icon keep the group`:** with A in `"CTM group"`, after `renameProject(A, "Server")` and `setIcon(A, "letter")`, A's `group` is still `"CTM group"`.
- [ ] **Step 2: Run** `node --test test/projects.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `setGroup` and the `group` field. Then fix any writer that drops fields, so the last test passes.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add src/projects.js bin/orca-wt.js test/projects.test.js && git commit -m "feat: project groups in the orca-wt cli"`

### Task 3: Group sections helper

**Files:**
- Modify: `mods/projects/group.js`
- Test: `test/projects-group.test.js`

**Interfaces:**
- **Consumes:** the saved project entries carry `group` (from Task 2).
- **Produces:**
  - `group()` sets `g.group` (a `string | null`) on repo groups from the saved entry, next to `displayName` and `icon`.
  - `projectGroups(groups, sort = "added"): Section[]`, where `Section = { name: string | null, key: string | null, projects: Group[] }`.
    - Named sections come first, in first-appearance order. Under `"name"` sort, the sections are sorted by name and the projects inside each section by `displayName`.
    - Then one `{ name: null, key: null, projects }` section holds everything ungrouped. Its projects keep today's `sortGroups` behaviour: machines, then "other", last.
    - Each named section's `key` is `"group:" + name.toLowerCase()`.
    - Names are matched case-insensitively. The first spelling seen wins.

- [ ] **Step 1: Write the failing tests:**
  ```js
  const G = (name, group, kind = "repo") => ({ kind, key: name, name, displayName: name, group, rows: [] });
  test("projectGroups puts named groups first in first-appearance order", () => {
    const s = g.projectGroups([G("a", null), G("b", "CTM"), G("c", "Zed"), G("d", " ctm "), G("other", null, "other")]);
    assert.deepEqual(s.map((x) => [x.name, x.key, x.projects.map((p) => p.name)]), [
      ["CTM", "group:ctm", ["b", "d"]], ["Zed", "group:zed", ["c"]], [null, null, ["a", "other"]],
    ]);
  });
  test("projectGroups name sort orders groups and their projects", () => {
    const s = g.projectGroups([G("y", "Zed"), G("x", "Zed"), G("b", "Alpha"), G("a", null)], "name");
    assert.deepEqual(s.map((x) => [x.name, x.projects.map((p) => p.name)]), [["Alpha", ["b"]], ["Zed", ["x", "y"]], [null, ["a"]]]);
  });
  test("projectGroups with no groups is one unnamed section", () => {
    assert.deepEqual(g.projectGroups([G("a", null)]).map((x) => x.name), [null]);
  });
  ```
  Also add a test that `group(...)` copies `group` from a saved entry onto the repo group.
- [ ] **Step 2: Run** `node --test test/projects-group.test.js`. Expected: FAIL (`g.projectGroups is not a function`).
- [ ] **Step 3: Implement** both changes. Inside `projectGroups`, reuse `sortGroups` for the unnamed section.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add mods/projects/group.js test/projects-group.test.js && git commit -m "feat: project group sections helper"`

### Task 4: Group headers in the sidebar

**Files:**
- Modify: `mods/projects/main.js` (the Projects branch of `render()` around `sortGroups`/`visibleRows`, `renderHeader`, and the card margin)
- Create: `mods/projects/groups.svg` (a small tree or stack glyph, 14 px, `currentColor`)
- Test: `test/projects-mod.test.js` (the existing `harness` and `cardHarness`)

**Interfaces:**
- **Consumes:** `projectGroups` (Task 3).
- **Produces:**
  - `renderGroupHeader(section, isCollapsed, t, first): element`, with id `group-head-${section.key}`. It shows the `▸`/`▾` chevron, the `svg("mods/projects/groups.svg")` glyph and the bold name. Clicking it toggles `section.key` in `this.collapsed` and saves `projects.collapsed`, as the project headers do.
  - Projects inside a named section render with an extra left indent of **14 px**: the project header and the cards both shift.

- [ ] **Step 1: Write the failing harness tests:**
  - **`grouped projects render under a group header`:** a saved project A with `group: "CTM group"` and a space `s1` gives texts that contain `CTM group` before A's name. The element `group-head-group:ctm group` exists.
  - **`folding a group hides its projects but keeps the active card`:** A has two spaces, `s1` (active) and `s2`. Click the group header. A's header is still shown, `s1`'s card is shown, and `s2`'s card isn't. `localStorage.setItem` was called with `projects.collapsed` containing `group:ctm group`.
  - **`folded group with no active space shows only its header`.**
  - **`ungrouped projects render as before`:** with no groups, no `group-head-*` element exists, and the existing render tests still pass.
- [ ] **Step 2: Run** `node --test test/projects-mod.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Loop over the sections:
  - For a named section, push `renderGroupHeader`.
  - If the section is folded, render only the project whose rows include the active space, with `visibleRows(g, true)`.
  - Otherwise render each project as today, indented.

  `activeIndex` and `order` keep working as they do now.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install and look:**
  1. Run `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects`. Expected: `check passed`.
  2. Run `node bin/orca-wt.js projects set-group /Users/jimmy_nguyen/orca/Coduct.CTM.Server "CTM group"`. (This is the person's real data, so undo it in Step 6.)
  3. Take a screenshot with `herdr-app shot` and read it. Expected: a `CTM group` header with Server indented under it.
- [ ] **Step 6:** Undo with `node bin/orca-wt.js projects set-group /Users/jimmy_nguyen/orca/Coduct.CTM.Server`.
- [ ] **Step 7: Commit:** `git add mods/projects/main.js mods/projects/groups.svg test/projects-mod.test.js && git commit -m "feat: group headers in the projects sidebar"`

### Task 5: Open in menu and Customize apps

**Files:**
- Modify: `mods/orca-project/main.js` (the `renderHeader` and `renderSpace` rows; new modes `open-in` and `apps`)
- Modify: `mods/projects/main.js` (pass `folder` in the space popup props: the worktree path. For the header, `path` is already the primary checkout)
- Test: `test/projects-mod.test.js` (the orca-project harness via `overlayProps`)

**Interfaces:**
- **Produces:**
  - `subRow(id, label, onOpen, t)`: a `popupRow` with `›` on the right. In stacking mode it opens the side popup on hover (`on_hover(true)` with the row bounds from `on_mouse_down`, or on click when bounds aren't available). In drill-down mode, clicking swaps `this.mode`.
  - **Mode `open-in`**, with props `{ mode: "open-in", folder, parent }`:
    - On init it runs `cli apps list`.
    - Then it renders one row per `chosen` app (its label), a divider, and `Customize apps…`.
    - Clicking an app runs `cli open <id> <folder>`. On `{error}` it calls `notify({ title: "Open in", body: error, level: "error" })`. In every case it closes itself and its `parent` overlay.
  - **Mode `apps`**, a dialog of 320×360:
    - one checkbox row per `installed` app, prechecked from `chosen` (reuse `checkRow` from the options mode);
    - Cancel, and Save, which runs `cli apps set ...ids` and closes.

- [ ] **Step 1: Write the failing harness tests:**
  - **`header and space menus show Open in ›`:** the texts contain `Open in` and `›`.
  - **`open-in lists chosen apps then Customize apps…`:** the harness `exec` responds to `apps list` with `{installed: [vscode, zed, finder], chosen: ["zed", "finder"]}`. The texts are, in order, `Zed`, `Finder`, `Customize apps…`, and contain no `VS Code`.
  - **`clicking an app opens the folder and closes both popups`:** clicking `Zed` makes the harness record `exec` with args ending `open zed /r`, plus `closeOverlay` for its own id and for `parent`.
  - **`open failure notifies`:** when `open` responds `{error: "boom"}`, a `notify` is recorded with `level: "error"` and `body: "boom"`.
  - **`Customize apps saves the checked ids`:** untick `zed`, then Save. The recorded exec args end with `apps set finder`.
- [ ] **Step 2: Run** `node --test test/projects-mod.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement**, following Task 0's decision.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install and check by hand:**
  1. Run `bash scripts/install.sh orca-project projects && herdr-app check` for both mods. Expected: `check passed`.
  2. Ask the person to right-click a worktree card, choose Open in, then Zed. Zed should open that worktree.
  3. Then Customize apps…: untick VS Code and save. The next Open in menu should have no VS Code.
- [ ] **Step 6: Commit:** `git add mods/orca-project/main.js mods/projects/main.js test/projects-mod.test.js && git commit -m "feat: open in apps from the sidebar menus"`

### Task 6: Project Group menu and New group dialog

**Files:**
- Modify: `mods/orca-project/main.js` (a `Project Group ›` row in `renderHeader`; new modes `group` and `new-group`)
- Modify: `mods/projects/main.js` (header popup props gain `group: g.group` and `groups`, the list of existing group names in section order)
- Test: `test/projects-mod.test.js`

**Interfaces:**
- **Consumes:** `orca-wt projects set-group` (Task 2), and the `group`/`groups` props.
- **Produces:**
  - **Mode `group`**, with props `{ mode: "group", path, name, group, groups, parent }`. It shows:
    - `New group from project…`;
    - `Remove from group`, only when `group` is set;
    - then, when there are other groups, the dim heading `Move to group` and one row per group other than the current one, each with a `●` dot.

    Each action runs `set-group`, then `setShared("orca.projects.rev", Date.now())` so the sidebar reloads, then closes itself and `parent`.
  - **Mode `new-group`**, a dialog of 420×200, using the copy from Global Constraints.
    - The input is prefilled with `<name> group`.
    - Create is disabled when the trimmed value is empty.
    - When the value case-insensitively matches one of `groups`, the dialog shows the duplicate error inline and doesn't call the CLI.
    - Otherwise Create runs `set-group <path> <value>`. On `{error}` it shows the error inline; on success it bumps the rev and closes.

- [ ] **Step 1: Write the failing harness tests:**
  - **`header menu shows Project Group ›`.**
  - **`group popup lists actions and other groups`:** with props `{group: "CTM group", groups: ["CTM group", "Tools"]}`, the texts are, in order, `New group from project…`, `Remove from group`, `Move to group`, `Tools`. There is no `CTM group` row.
  - **`group popup for an ungrouped project hides Remove`.**
  - **`Move to group runs set-group and refreshes`:** clicking `Tools` records exec args ending `projects set-group /r Tools`, plus `setShared("orca.projects.rev", …)`.
  - **`new group dialog prefills, rejects duplicates, creates`:**
    - The input value is `Coduct.CTM.UserApp group`.
    - Typing `ctm GROUP` with `groups: ["CTM group"]` and pressing Create shows `A group with that name already exists — use Move to group`, with no `set-group` exec.
    - Typing `New one` and pressing Create records `projects set-group /r New one`.
- [ ] **Step 2: Run** `node --test test/projects-mod.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install and check by hand:**
  1. Run `bash scripts/install.sh orca-project projects` and `herdr-app check` for both. Expected: `check passed`.
  2. Ask the person to:
     - make a "CTM group" from the CTM Server project, then move UserApp and Admin into it;
     - fold the group while working in one CTM worktree, and check that the worktree stays visible;
     - remove all three from the group, and check that the group header disappears.
- [ ] **Step 6: Commit:** `git add mods/orca-project/main.js mods/projects/main.js test/projects-mod.test.js && git commit -m "feat: project group menu and new group dialog"`

---

**Decision (filled in by Task 0):** _pending_
