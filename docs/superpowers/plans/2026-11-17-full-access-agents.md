# Full-Access Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Agents started by the Create worktree dialog, and agents woken from sleep, get their full-access flag.
**Spec:** `docs/superpowers/specs/2026-11-17-full-access-agents-design.md`
**Constraints:** both `sleep.js` copies stay identical; no duplicate flags; DeepSeek TUI is unchanged; commits have no AI co-author trailer.

### Task 1: `fullAccessFlags`, and using it at both launch points

- [ ] **Step 1: Failing tests** in `test/sleep.test.js`. Use `assertBoth`:
  - `fullAccessFlags("claude", ["claude"])` → `["--dangerously-skip-permissions"]`.
  - `fullAccessFlags("codex", ["codex", "--no-daemon"])` → `["--dangerously-bypass-approvals-and-sandbox"]`.
  - `fullAccessFlags("agy", [])` → `["--dangerously-skip-permissions"]`.
  - `fullAccessFlags("claude", ["--dangerously-skip-permissions"])` → `[]`.
  - `fullAccessFlags("dsh", [])` → `[]`, and `fullAccessFlags(null, [])` → `[]`.
  - `withFlags("codex", "codex resume abc", [...keptFlags("codex", ["codex", "--no-daemon"]), ...fullAccessFlags("codex", [])])` → `"codex --no-daemon --dangerously-bypass-approvals-and-sandbox resume abc"`.

  In `test/projects-mod.test.js`, a worktree request with `agent: { name: "Codex", run: ["codex", "--no-daemon"] }` must call `space.new` with `argv` `["codex", "--dangerously-bypass-approvals-and-sandbox", "--no-daemon"]`. Make the harness's `run` record its calls.
- [ ] **Step 2: Run them.** `npm test` → the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add `fullAccessFlags` and its export to both `sleep.js` copies.
  - Change the worktree request (`main.js`, around line 601) and the wake flag build (around line 347) as the spec describes.
- [ ] **Step 4: Run all tests.** `npm test` → all pass. Then `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects` → `check passed`.
- [ ] **Step 5: Commit.** `git commit -m "feat: full-access flags for new-worktree and woken agents"`
