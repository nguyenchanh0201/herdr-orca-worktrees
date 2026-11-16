# Sidebar collapse and resize like Orca — design (Herdr.app)

Date: 2026-11-17. Small change to the person's `orca` layout, `mods/projects`,
`mods/orca-setup`, and `programs.json`.

## Intent

Make the `orca` layout's sidebar behave like Orca's: drag its edge between
220 and 500 px, and collapsing hides it completely (no icon rail). Today the
top-left toggle (shipped `workspace-chrome`) shrinks the sidebar to a 76 px
rail, and `projects` has no rail view, so it draws a squeezed list ("▸ 4 ▸ 5").
Also rename `dsh-tui` so the person recognises it.

## Goals / non-goals

- Goals: drag range 220–500 px; the existing toggle button and `cmd-b` both
  fully hide/show the sidebar; a visible way back when it's hidden; `dsh-tui`
  shown as "DeepSeek TUI".
- Non-goals: an icon rail; editing shipped mods or `layouts/main.json`;
  usage meters (separate design).

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Hide completely, as Orca | Nothing to draw when collapsed; needs a way back that lives outside the sidebar |
| B | Keep Herdr's rail, give `projects` an icon view | Not Orca's behaviour |

The person picked A.

## Design

1. **Drag range.** In `~/.config/herdr-app/layouts/orca.json`, the node
   `"id": "sidebar"`: `"min": 220`, `"max": 500` (were 44 / 480).
2. **Toggle hides.** The shipped toggle calls `layout.resize sidebar` to 76 px
   (it saves the old width in `shared("sidebar.width")` first). Herdr stores
   that size even below `min` (checked: `layout.resize panel 100` with
   `min 280` stored 100 in `layouts/.state/orca.json`). So `projects`' 500 ms
   `check()` reads `layout()`'s `sidebar` node: if it isn't hidden and its
   `size.px < 160`, it runs
   `run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 })`,
   `setShared("sidebar.collapsed", false)`, then
   `run("layout.hide", { id: "sidebar" })`. Net effect: the button hides the
   sidebar, and it comes back at its old width. This also repairs the current
   saved 90 px state on first run.
3. **Way back.** `cmd-b` already runs `layout.toggle:sidebar` (`keys.json`).
   Plus a button at the left of the bottom `orca` strip (`orca-setup`),
   before the "orca" label: a sidebar icon (`svg("mods/workspace-chrome/…")`
   if a suitable shipped icon exists, else `◧`), shown only while the
   sidebar is hidden; click → `run("layout.show", { id: "sidebar" })`. The
   strip is outside the sidebar, so it is always visible; the shipped tabs
   bar already pads for the macOS window buttons when the sidebar is hidden.
4. **Rename.** Create `~/.config/herdr-app/programs.json`:
   `{ "programs": { "dsh-tui": { "name": "DeepSeek TUI" } } }`; confirm no
   `programs.error`. Changes the name in every Herdr list, menu and toast.

## Testing

- `herdr-app check` on `projects` and `orca-setup`; `npm test` green.
- Manual: drag the edge — stops at 220 and 500; top-left toggle → sidebar
  disappears, terminal fills the width, strip shows the sidebar button; click
  it → sidebar back at its old width; `cmd-b` hides/shows; quit and relaunch
  with it hidden → still hidden, button shown; the `+` menu shows
  "DeepSeek TUI"; `ctrl-shift-l` to `main` → Herdr's rail behaviour unchanged
  there.

## Left to the builder

- The exact icon for the strip button.
