# Full-access agents for new worktrees and wake

## Why

Agents started for a new worktree, or woken from sleep, stop to ask for permission. The person wants them to start with full access.

## Goals

- **Full-access flags:**
  - Claude and Antigravity: `--dangerously-skip-permissions`.
  - Codex: `--dangerously-bypass-approvals-and-sandbox`.
  - DeepSeek TUI: none (it has no such flag).
- **When they are added:**
  - When the Create worktree dialog starts an agent (`kind: "worktree"` request), the flag goes right after the program word.
  - On wake, it goes into the kept flags, so the resume command gets it after the program word (the existing `withFlags`).
- **No duplicates:** a flag that is already present is not added again.

## Non-goals

- Agents started from Herdr's own menus, and `programs.json`.

## Approaches

- **Add the flags in our two launch paths (picked).**
- Override `run` in `programs.json`. Rejected: it would change every agent Herdr starts.

## Design

- **The helper:** `fullAccessFlags(kind, existing) -> string[]` in both `src/sleep.js` and `mods/projects/sleep.js`. It returns the flags for that kind that are missing from `existing`. The two copies stay identical, as the `assertBoth` tests require.
- **New worktree:** in `mods/projects/main.js`, the worktree request maps `basename(run[0])` through the sleep kind map, then builds `argv = [run[0], ...fullAccessFlags(kind, run), ...run.slice(1)]`.
- **Wake:** `flags = keptFlags(kind, argv)`, then `flags.push(...fullAccessFlags(kind, flags))`.
