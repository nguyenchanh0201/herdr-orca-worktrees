# "Open in" and project groups

## Why

The person works across several related repos: the CTM Server, UserApp and Admin Portal. In the projects sidebar these sit among every other project. Orca lets you:
- put related projects in a **project group** that folds as one;
- open any worktree in an editor or Finder from its right-click menu.

We follow Orca, from the person's screenshots (2026-11-17).

## Goals

### "Open in"

- An **Open in ›** row appears on two right-click menus:
  - a worktree card's menu, which opens that worktree's folder;
  - a project header's menu, which opens the project's main checkout (`g.primary`).
- Hovering the row opens a **side popup** next to it, listing the chosen apps, then a divider, then **Customize apps…**. Clicking an app opens the folder in it and closes both popups.
- **App list:**

  | App | Shown when |
  |---|---|
  | Finder | always (it ships with macOS) |
  | VS Code, Zed, Cursor, Xcode, Terminal, Ghostty | the app is installed |

  "Installed" means `/Applications/<App>.app` or `~/Applications/<App>.app` exists.
  - The default chosen set is every installed app except Terminal and Ghostty, in the order above.
  - Today that means VS Code, Zed, Xcode and Finder.
- **Opening:** run `open -a "<App name>" <folder>`, or `open <folder>` for Finder. Errors go to a notification.
- **Customize apps…** opens a small dialog listing every installed app with a checkbox, plus Save and Cancel. The choice is kept and survives restarts.

### Project groups

- **Project Group ›** appears on a project header's right-click menu. It opens a side popup with:
  - **New group from project…**: opens a dialog titled "New Project Group", with the subtitle "Create a group and move this project into it."
    - It has one "Group Name" field, prefilled with `"<project display name> group"`, plus Cancel and Create.
    - Create moves the project into the new group.
  - **Remove from group**: shown only when the project is in a group.
  - Then a **Move to group** heading that lists every other existing group. Clicking one moves the project there.
- **Sidebar tree:** the order is group, then project, then worktree cards.
  - A group header shows a groups glyph and the group name in bold. It can be folded, and folding hides every project in the group.
  - The fold state is kept in `localStorage` under the same key as project folds today, with the key prefixed by `group:`.
  - The project headers and cards inside a group are indented one step.
  - Groups come first, in the order they were created. Ungrouped projects follow, exactly as they look today. The "other" group stays last.
- **A group exists while at least one project names it.** Moving its last project out removes the group.
- **Grouping saves the project.** Grouping a repo that is only open, not saved, first adds it to the saved projects.

## Non-goals

- Orca's **Copy ›** and **Parent & Children ›** menus.
- Renaming or deleting a group from its own header. Moving the last project out removes it.
- Dragging projects between groups.
- Adding custom apps by path.
- Changes to the Activity view.

## Anti-goals

- **The side popup never flickers or strands itself.**
  - Clicking outside either popup, pressing Esc, or picking an item closes both.
  - Moving between the row and the side popup keeps it open.
- **No data loss in `projects.json`.**
  - Every write keeps the fields it doesn't own (`name`, `icon`, `group`). Today's `writeProjectsAtomic` writes back only the entries it was given, so every writer must pass whole entries.
  - A failed group change leaves the file as it was.
- **No network calls.**

## Approaches

- **A. A side popup beside the hovered row, like Orca (picked).**
  - It opens with `openOverlay({kind: "popup", frame: "none", at})`, positioned from the row's bounds.
  - Herdr's docs say "Esc closes the top dialog or popup", which suggests popups stack. The first build task checks this live.
- **B. Drill down in place.** The same popup swaps to the submenu, with a "‹ Back" row. This is the fallback if popups don't stack.
- **C. One flat menu with section headings.** Rejected: about 10 rows, and it doesn't look like Orca.

## Design notes

### Data

- A project entry in `projects.json` gets an optional **`group: string`** (the group's name). Group order is the order in which each name first appears among the projects.
- App choice lives in `~/.local/state/orca-worktrees/apps.json` as `{ "version": 1, "apps": ["vscode", "zed", ...] }`. When the file is missing, the default set applies.

### CLI (`orca-wt`)

| Command | What it does |
|---|---|
| `projects set-group <path> <name>` | Saves the project if needed, then sets its group. |
| `projects set-group <path>` | With no name, removes the project from its group. |
| `projects list` | Each entry now includes `group`. |
| `apps list` | Returns `{ installed: [{id, name}], chosen: [ids] }`. |
| `apps set <ids...>` | Saves the chosen set. |
| `open <app-id> <folder>` | Runs `open`. |

### Mods

- **`group.js`:**
  - `groupRepos` (or a small new helper) carries `g.group` from the saved entry.
  - A pure `projectGroups(groups)` returns the ordered `{name, projects}` list plus the ungrouped rest. It is unit-tested.
- **`projects/main.js`:**
  - Renders group headers.
  - Indents grouped projects.
  - Folds by `group:<name>`.
- **`orca-project`:**
  - The `header` and `space` menus gain the `›` rows.
  - New modes:
    - `open-in` and `group`: the side popups;
    - `new-group`: the dialog;
    - `apps`: the Customize apps dialog.
  - The side popup gets `at = { x: row.right + 4, y: row.top }`, taken from the row's `on_mouse_down` or hover bounds.

## Calls made after the builder check

- **A folded group still shows where you are.** It behaves like a project fold today (`visibleRows`): a folded group shows its header, plus the project header and card of the active space, if that space is in the group.
- **Group order is creation order.**
  - `set-group` with a name no project has yet moves that project's entry to the end of `projects.json`, so a new group lands last.
  - Moving a project into an existing group leaves the file order alone.
- **"Sort: Name"** sorts groups by name and the projects inside each group by name. Ungrouped projects sort as they do today.
- **Group names are trimmed and matched case-insensitively.** New group with a name that's already taken shows an inline error, "A group with that name already exists — use Move to group". An empty name disables Create.
- **Apps that are chosen but no longer installed are hidden when the menu shows, and kept in `apps.json`.** If they're installed again, they come back.

## Left to the builder

- Exact sizes, padding and the group glyph (an svg like `moon.svg`).
- The app icons: a generic folder or app glyph is fine. Real app icons are optional.
- How the side popup closes when the main popup closes. Pass the parent's overlay id, or close both on pick.
