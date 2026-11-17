# Agents under their worktree in the projects sidebar — design

Date: 2026-11-17. Small change to `mods/projects` (see
`2026-11-16-projects-sidebar-design.md`).

## Intent

Like Orca, one list: each space row in the projects sidebar has its agents
under it, and the separate Agents panel goes away. Today the `orca` layout
shows our project list on top and Herdr's shipped `agents` mod (grouped by
status) below, so agents aren't split by project.

## Goals / non-goals

- Goal: under each space row, one line per agent in that space; Herdr's
  Agents panel removed from the person's `orca` layout.
- Non-goals: status summary headers ("Idle 1"), the agents history button,
  pinning, sub-agents (`hc run` children), sorting agents by urgency.
- Anti-goals: editing the shipped `agents` mod or `layouts/main.json`.

## Approaches

| | Approach | Trade-off |
|---|---|---|
| **1 (picked)** | Agent lines inside `projects`; drop the Agents block from `orca.json` | One list, as Orca; loses the panel's summary and history button |
| 2 | Keep the Agents panel, also group it by project | Two lists of the same projects |

The person picked 1 ("follow Orca").

## Design

- Data: `agents()` (live). An agent belongs to the row whose `space.id ===
  agent.space`; within a row, in `agents()` order (space, tab, pane).
  Pure helper in `mods/projects/group.js`:
  `agentsBySpace(agents) => Map<spaceId, AgentInfo[]>`.
- Line (24px, indented 24px under its row): program icon (as `new-menu`
  draws it: `svg` tinted when `program.tint`, else `image`), `program.name`
  (`muted`), status word in `theme()[status]`, and time in that status
  (`2m`, `1h`; nothing under a minute).
- Time in status: `projects` keeps `since[address] = { status, at }`, reset
  when the status changes (the shipped `agents` mod does the same; first seen
  = now). The 500 ms check adds the current minute to its signature so the
  times redraw once a minute.
- Click a line: `run("pane.focus", { pane: agent.pane })` (as the shipped
  mod).
- Collapsed group: its visible (active) row keeps its agent lines.
- `setAgentOrder(addresses in the order drawn)` on render, so
  `agent.next`/`agent.prev` keys follow the sidebar now that the Agents
  panel is gone.
- Layout: remove the block `"id": "agents"` from
  `~/.config/herdr-app/layouts/orca.json` (the `projects` block then fills
  the column). `ctrl-shift-l` to `main` still shows Herdr's Agents panel.

## Testing

- `node --test`: `agentsBySpace` groups by `space`, keeps `agents()` order,
  ignores agents whose space isn't listed.
- `herdr-app check mods/projects`; `npm test` green.
- Manual: a space with Claude + Antigravity shows two lines under it with
  status and time; Claude asks permission → its line turns blocked; click a
  line → that pane is focused; the Agents panel is gone from `orca`;
  `agent.next` walks agents in sidebar order.
