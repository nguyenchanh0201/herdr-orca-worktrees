# Sidebar tree layout

## Why

Worktree cards are full width, start at the project name's left edge and each have a border. So the projects sidebar reads as a stack of equal boxes, not a project → worktree tree. Status dots differ in size (`●` vs `·`), so the names don't line up. (The person's screenshot, 2026-11-17.)

## Goals

- **Worktree cards are indented under their project,** so the dot sits under the project icon and the name lines up past it.
- **No card borders.** A card gets a background only when its space is active (`t.selected`) or the pointer is over it (`t.hover`). Hover changes colour only, never size.
- **Every worktree has a same-size dot in a fixed-width slot.** A worktree with no status shows a `t.dim` `●`; the sleeping moon stays.
- **The agent strip is lighter:** it starts under the worktree name, and has no background until hovered. Click behaviour is unchanged.
- **Project headers get more space above them** than the gap between worktrees, except the first one.

## Non-goals

- Orca's second line ("Local Mac" chip, branch, PR icon).
- The full-access agent flags. That's a separate change.

## Approaches

- **Restyle the existing cards and headers in `mods/projects/main.js` (picked).** Only spacing and colour change; the structure and every click stays the same.
- Draw tree guide lines. Rejected: Orca doesn't, and indenting is enough.

## Left to the builder

Exact pixel values. Tune them from a `herdr-app shot` against the screenshot.
