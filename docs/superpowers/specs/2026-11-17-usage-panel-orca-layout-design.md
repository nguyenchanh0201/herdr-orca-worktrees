# Usage panel: Orca layout

## Why

The usage popup should look and sit like Orca's. Today it is one fixed 760×420 box that covers the status bar. Its list has empty space under it, and switching between Detailed and Compact does not change the list. It should also fit the Herdr window at any size.

## Goals

- The list is a compact card sitting just above the status bar, as tall as its rows.
- The selected provider's details float beside it as their own card, as tall as their content.
- Detailed and Compact change the list rows the way they do in Orca.
- The popup scales with the window: cards cap their height and scroll, and the details card moves above the list when the window is too narrow for both side by side.

## Non-goals

- Orca's "Usage details & history" and "Manage Accounts…" rows.
- The status-bar chips (`orca-usage` strip render) stay as they are.

## Anti-goals

- The hover flicker must not come back. Hovering a row must never change the list card's size or position (see commit `1b3783d`).
- The popup must not cover the status bar.

## Approaches

- **A. One borderless popup drawing two cards (picked).** `frame: "none"` with a window-share size. The mod draws both cards bottom-aligned with a see-through gap.
- B. Two popups, one for the list and one for the details, with the details opened on hover. Rejected: opening a second popup likely closes the first, and the hover handoff between them would flicker.
- C. Keep the single box and only make it scale. Rejected: no floating details card, so it doesn't follow Orca.

## Design

**Opening** (`mods/orca-usage/main.js`): `openOverlay({ mod: "orca-usage-panel", kind: "popup", frame: "none", width: <share>, height: <share>, at })`. Take `at` from the strip's `on_mouse_down` event `bounds`, so the popup's bottom edge lands on the strip's top edge. Start with `width` 0.7 and `height` 0.85, then tune.

**Panel** (`mods/orca-usage-panel/main.js`): the root fills the overlay and is transparent. Clicking the transparent area closes the popup with `closeOverlay(props().overlay)`. Inside, a bottom-aligned row with gap 8 holds:

- **List card** (about 340 px wide, `bg(t.popover)`, border, rounded 10, `max_h` = overlay height, scrolls):
  - Header: "Usage", "all agents", refresh button.
  - The Detailed/Compact switch.
  - The rows.
  - The unavailable providers.
- **Details card** (about 300 px wide, same style, as tall as its content up to the overlay height, scrolls). It shows the selected provider:
  - Header: icon, name, and "Updated Xm ago" on the line under the name.
  - A divider.
  - Each window: its name, a full-width bar, and "N% used" on the left with "Resets in …" on the right.
  - The extra "Default account" box goes away.

When `on_size_change` reports less width than both cards plus the gap, the details card moves above the list card instead of beside it.

**Rows**

- **Compact** (unchanged): icon, name, the most-used window's reset time, its %, and `›`.
- **Detailed** (new, like Orca):
  - First line: icon, **Name**, "Resets in …" for the most-used window (muted), and `›` vertically centered.
  - Under it, the windows:
    - Claude and Codex: one line of `short-label [48×6 bar] N%` groups, with the short labels `5h`, `wk` and `Fable`.
    - Antigravity: one line per window with its full label, since the labels are long.
  - Bar and % color: red at 80% and up, yellow at 60% and up, otherwise muted. This is the Orca look. `barColor` changes to match, and the details card uses it too.

Row height depends on the mode, never on hover.

## Left to the builder

- Check how `at` places a popup (its top-left corner, or growing upward) and whether `frame: "none"` keeps clicks outside closing it. Tune the size shares and widths by eye against the Orca screenshots.
- If the strip's `bounds` aren't available, fall back to the pointer with a fixed upward offset.
