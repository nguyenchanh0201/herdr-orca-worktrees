# Sidebar Tree Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Projects → worktrees read as a tree: indented, borderless cards, aligned dots and a lighter agent strip.
**Architecture:** Styling changes only, in `renderHeader`, `renderCard` and `renderRow` in `mods/projects/main.js`.
**Tech Stack:** Herdr.app mod; Node `node:test` harness (`test/projects-mod.test.js`).
**Spec:** `docs/superpowers/specs/2026-11-17-sidebar-tree-layout-design.md`

## Global Constraints
- Hover changes colour only, never size. No new data, CLI calls or click changes.
- Commits: no AI co-author trailer.

## Review Focus
- The active card must still be visibly highlighted: the harness test checks `bg` = `t.selected` on the active card.
- A card with no status must render the same-size dot: the harness test checks the `●` text.

---

### Task 1: Tree styling

**Files:** Modify `mods/projects/main.js`; Test `test/projects-mod.test.js`

- [ ] **Step 1: Failing harness tests:**
  - `worktree cards are indented and borderless`: the card element has `ml` > 0 and no `border` attr.
  - `active card is highlighted on the card, not the row`: the active card has `bg` set to the theme's `selected`.
  - `status-less worktree shows the dim dot`: a row with no `space.status` renders `●` (not `·`) inside a fixed-`w` slot.
  - `agent strip has no background until hover`: the strip has no `bg` attr, but has a `hover`.
- [ ] **Step 2: Run them.** `node --test test/projects-mod.test.js` → the new tests FAIL.
- [ ] **Step 3: Implement.**
  - **Card:** drop `border`/`border_color`; use `ml(22)`, `p(2)`, `mb(2)`, `rounded(6)`; on active `bg(t.selected)`, otherwise `hover(bg t.hover)`.
  - **Row:** drop its own active `bg` and hover; use `pl(8)`; put the dot in `div().w(12).flex_none()`, with a `t.dim` `●` when there's no status.
  - **Strip:** `ml(18)`, no `bg`, `hover(bg t.hover)`.
  - **Header:** `mt(8)` for every group except the first (pass `first` from the render loop).
- [ ] **Step 4: Run all tests.** `npm test` → all pass. Update older tests that asserted the card border or the row bg.
- [ ] **Step 5: Look at it.** `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects`, then `herdr-app shot` on the Projects view. Tune the pixel values until the dots sit under the project icon.
- [ ] **Step 6: Commit.** `git add mods/projects/main.js test/projects-mod.test.js && git commit -m "feat: tree layout for projects and worktrees"`
