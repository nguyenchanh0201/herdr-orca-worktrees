# Worktree cards with a fold-out agent list

## Why

In the projects sidebar every agent gets its own row under its worktree and nothing folds, so a few busy worktrees fill the sidebar. Orca shows each worktree as a card whose agents fold into one strip. We follow Orca (the person's screenshots, 2026-11-17).

## Goals

- **Each worktree row becomes a card** (rounded, `t.border`, a small gap between cards). The title line is today's: status dot (or moon when sleeping), `label(row, logins)`, and a **`main`** badge on the main checkout in place of ★. A machine chip is shown only for spaces on a remote machine (`space.machine` set).
- **Folded (the default):** below the title, one strip in a rounded inset (`t.raised` or `t.hover` background). It shows the most urgent agent status, then each agent's icon (13 px, at most 5, then `+N`), then `›` on the right. Clicking the strip unfolds the card.
- **Unfolded:**
  - A row "N agent(s)" with `⌄`; clicking it folds the card.
  - Then one row per agent: status glyph, icon, "`Status` - `Name`" (for example "Done - Claude"), and the elapsed time (today's `elapsed`).
  - Clicking an agent row focuses that agent (`pane.focus`).
- **Urgency order:** blocked > working > done > idle.
  - Glyphs: blocked `!`, working `●`, done `✓`, idle `○`.
  - Each glyph is coloured with `t[status]`, as today.
- **A blocked agent always shows in the folded strip** through the urgency glyph. The card stays folded; nothing unfolds by itself.
- **Fold state:** each worktree remembers it, keyed by the worktree path. It is stored in `localStorage` `projects.agentsOpen` (a list of open paths) and survives restarts.
- **Sleeping worktrees:** the strip shows the sleeping agents' icons dimmed, plus a moon glyph. Unfolded, it shows today's "asleep" rows.
- **No agents:** no strip; the card is just the title line.
- **Interactions stay as they are:**
  - Clicking the title line selects the space, or wakes a sleeping worktree.
  - Right-click opens the space menu.
  - The active space is highlighted (`t.selected` on the card).
  - The `setAgentOrder` and `scroll_to_item` behaviour is kept.

## Non-goals

- Orca's second line ("Local Mac" chip, branch, ports plug). Every space here is local, so it would add nothing.
- Changing the Activity view.
- Unfolding on hover.

## Anti-goals

- **Card height never changes on hover.** It changes only on a click, or when agents come or go.
- **No extra CLI or network calls.** Everything comes from `agents()`, `spaces()` and the sleep records the sidebar already has.

## Approaches

- **A. Card per worktree with a fold-out agent list (picked).**
- B. Flat rows with a small "N agents ›" fold line. Rejected: it doesn't look like Orca.
- C. Unfold on hover. Rejected: rows resizing under the pointer flicker. This is the same problem we fixed in the usage panel.

## Design notes

- **Pure helpers, in `mods/projects/group.js` and unit-tested:**
  - `topStatus(agents)` returns the most urgent status, or `null` when there are none.
  - `agentSummary(agents, max = 5)` returns `{ icons: agents.slice(0, max), more: agents.length - max }`.
  - `STATUS_GLYPH` maps each status to its glyph.
- **`render()`:** pushes one card element per row where it pushes `renderRow` plus the agent rows today. `renderRow` becomes the card's title line. The card wraps the title line, plus the strip or the list.
- **Sidebar order:** `scroll_to_item` indexes now count cards, not rows. The active index is the card's index.

## Left to the builder

- Exact padding, radii and inset colour.
- Whether the "N agents" header row and the `+N` overflow get tooltips.
