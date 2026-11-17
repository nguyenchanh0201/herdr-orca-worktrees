# Worktree agent picker — design (Herdr.app)

Date: 2026-11-17
Second of the four Orca features (after the projects sidebar,
`2026-11-16-projects-sidebar-design.md`). Small change.

## Intent

When the person makes a worktree from the projects sidebar, they choose the
agent (Claude, Codex, agy, dsh-tui, or a plain terminal) and the new space opens
with that agent running. They work in the worktree themselves with the agent;
they don't hand it a task up front.

## Goals / non-goals / anti-goals

- Goal: the sidebar header's `+` asks "Terminal or which agent?", then opens
  Herdr's New worktree dialog; the new space's only tab runs the chosen agent.
- Non-goals: a first-prompt field; holding the agent until `scripts.setup`
  finishes (it starts at once, setup runs in its own tab, as Orca's default);
  a second shell or split; permission/yolo flags; the picker on Herdr's own
  right-click "New worktree" (shipped file).
- Anti-goals: re-implementing or forking Herdr's worktree creation; editing
  shipped mods.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Small popup menu (agent first) → Herdr's `worktree` dialog with `argv` | Reuses all of Herdr's git logic; two steps |
| B | Own dialog, branch + agent in one | One step; re-implements worktree creation (~200 lines) |
| C | `mod.clone worktree` + agent row | One step; a never-updated fork |

The person picked A.

## Design

- New mod `mods/orca-new/` (`mod.json`: `{ "place": "none", "title": "New worktree" }`),
  installed by `scripts/install.sh` (added to the default list). Opened by
  `projects`' `+` instead of the worktree dialog:
  `openOverlay({ mod: "orca-new", kind: "popup", width: 250, height: 260,
  props: { folder: <primary> } })`.
- Agent list: `knownAgents()` (local machine), shown at once from the shipped
  `+` menu's cache `shared("new-menu.agents")?.[""]` and refreshed in the
  background (writing the cache back the same way). Installed agents only,
  in the order `knownAgents()` returns (most picked first). dsh-tui shows if
  Herdr's program table has it with a `run`; if not, the fix is a
  `programs.json` entry, not code. "Checking installed agents…" while empty;
  "Could not check installed agents" on failure (Terminal still works).
- Rows, styled like the shipped `new-menu`: **Terminal**, a "Start an agent"
  label, then each agent with its icon and key hint `1`–`9`. Click or number
  key chooses; Esc closes (Herdr default).
- Choosing: `closeOverlay(props().overlay)`, then
  `openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280,
  props: { folder, machine: null, action: "new", argv: agent.run, tab: agent.name } })`;
  Terminal passes no `argv`/`tab` (today's behaviour). Herdr's dialog runs
  `space.new { folder, tab, argv }`, so the agent runs in the person's
  interactive shell, and `orca-setup` still adds its Setup tab.
- `projects` change: the `+` handler opens `orca-new` instead of `worktree`.

## Testing

- `herdr-app check` on `orca-new` and `projects`.
- Manual: `+` on a repo → picker lists Claude, Codex, agy, DSH; `1` →
  branch dialog → Enter → new space under its repo with a "Claude" tab running
  claude and a Setup tab; Terminal → plain shell as before; Esc in either step
  leaves nothing created.

## Left to the builder

- Popup height to fit its rows; icons as `new-menu` draws them.
