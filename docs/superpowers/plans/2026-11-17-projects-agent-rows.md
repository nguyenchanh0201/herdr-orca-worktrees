# Agents Under Worktree Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each space row in the `projects` sidebar lists its agents (icon, name, status, time in status), and Herdr's separate Agents panel is removed from the `orca` layout, as in Orca.

**Architecture:** A pure `agentsBySpace(agents)` in `mods/projects/group.js` (unit-tested). `mods/projects/main.js` tracks each agent's time-in-status in its existing 500 ms `check()`, draws agent lines under each drawn row, and calls `setAgentOrder` with the drawn order. One block is removed from `~/.config/herdr-app/layouts/orca.json`.

**Tech Stack:** Herdr.app mods (gpui-kit, gpui-base, `herdr`), Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-projects-agent-rows-design.md`

## Global Constraints

- Never edit shipped mods (`agents`, `new-menu`) or `layouts/main.json`; only `~/.config/herdr-app/layouts/orca.json` changes outside the repo.
- `render()` stays free of side effects except `setAgentOrder(...)` (the shipped `agents` mod does the same in render) and the existing `keyOf` / scroll bookkeeping.
- No new timers: reuse the 500 ms `check()`; no `exec`.
- Agent line: 24px high, indented 24px; colours only from `theme()`; status colour `theme()[status] ?? t.unknown`, name in `muted`.
- Time format: `< 60 s` → nothing; `< 60 min` → `Nm`; else `Nh` (whole numbers, floor).
- Click → `run("pane.focus", { pane: agent.pane })`.
- Commits: no AI co-author trailer.

## Review Focus

1. An agent whose status changes must restart its timer (not keep counting from first sight) — test in Task 1 (`sinceUpdate resets on status change`).
2. Agents that ended must be dropped from the timer map so it doesn't grow forever — test in Task 1 (`sinceUpdate drops gone agents`).
3. A collapsed group still shows its active row's agent lines — Task 2 Step 3 (lines drawn for every *drawn* row) + manual check 4.
4. Status change alone (no space/place change) must redraw — Task 2 Step 2 adds agent status to the `check()` signature; manual check 2.
5. With the Agents panel gone, `agent.next` / `agent.prev` must still work — Task 2 Step 4 `setAgentOrder`; manual check 5.

---

## Files

- Modify: `mods/projects/group.js` (add exports), `mods/projects/main.js` (`check()` ~line 83-91, render loop ~line 180-190, new `renderAgent`)
- Test: `test/projects-group.test.js` (add tests)
- Modify (outside repo, Task 3): `~/.config/herdr-app/layouts/orca.json` — remove block `"id": "agents"`

### Task 1: Pure helpers

**Interfaces — Produces (named exports of `mods/projects/group.js`):**
- `agentsBySpace(agents: AgentInfo[]) => Map<string, AgentInfo[]>` — keyed by `agent.space`, each list in input order.
- `sinceUpdate(prev: Map<string, {status: string, at: number}>, agents: AgentInfo[], now: number) => Map<...>` — new map: an address keeps `prev`'s entry if its status is unchanged, else `{ status, at: now }`; addresses not in `agents` are dropped.
- `elapsed(ms: number) => string` — `""` under 60 000; `"Nm"` under 3 600 000; else `"Nh"`.

- [ ] **Step 1: Write failing tests** in `test/projects-group.test.js` (same `g = await import(...)` loader):
  - `agentsBySpace groups by space in order`: `[{address:"a",space:"s1"},{address:"b",space:"s2"},{address:"c",space:"s1"}]` → `get("s1").map(x=>x.address)` = `["a","c"]`, `get("s2")` = `["b"]`, `get("s3")` = `undefined`.
  - `sinceUpdate keeps time while status same`: prev `{a:{status:"idle",at:100}}`, agents `[{address:"a",status:"idle"}]`, now 500 → `a.at === 100`.
  - `sinceUpdate resets on status change`: same but status `"working"` → `{status:"working", at:500}`.
  - `sinceUpdate starts new agents at now`: empty prev, agent `b` → `b.at === 500`.
  - `sinceUpdate drops gone agents`: prev has `a`, agents `[]` → result `size === 0`.
  - `elapsed`: `59_999`→`""`, `60_000`→`"1m"`, `3_599_999`→`"59m"`, `3_600_000`→`"1h"`, `7_300_000`→`"2h"`.

- [ ] **Step 2: Run** `node --test test/projects-group.test.js` → the new tests FAIL (not exported).

- [ ] **Step 3: Implement** the three exports in `group.js` (no imports added).

- [ ] **Step 4: Run** `npm test` → all pass.

- [ ] **Step 5: Commit** `git add mods/projects/group.js test/projects-group.test.js && git commit -m "feat: agent grouping helpers for projects"`

### Task 2: Agent lines in the sidebar

**Interfaces — Consumes:** Task 1 exports; `herdr`: `agents`, `setAgentOrder`, `run`; `gpui-kit`: `svg`, `image`.

- [ ] **Step 1: State.** In `init`, `this.since = new Map()`.

- [ ] **Step 2: `check()`.** After the existing signature (`nextSig`, ~line 86): `const ag = agents(); this.since = sinceUpdate(this.since, ag, now);` and append to `nextSig` `|agents=` + `ag.map(a => a.address + ":" + a.status).join(",")` + `|min=` + `Math.floor(now / 60000)` so status changes and the minute tick redraw.

- [ ] **Step 3: Render.** In the render loop (~line 184-190), compute `bySpace = agentsBySpace(agents())` once; after pushing each drawn row, push `renderAgent(a, t, now)` for each `bySpace.get(row.space.id) ?? []` and collect `a.address` into `order`. `renderAgent`: `h_flex().id("agent-" + a.address)`, h 24, `pl(24)`, gap 8, rounded, hover `t.hover`, `on_click(() => run("pane.focus", { pane: a.pane }))`; children: icon (`a.program.tint ? svg(a.program.icon).size(13).text_color(t.foreground) : image(a.program.icon).size(13)`; `svg("icons/agent.svg")` if `program.icon` is null), `div().flex_1().truncate().text_color(t.muted).child(a.program.name)`, status word in `t[a.status] ?? t.unknown`, `elapsed(now - (this.since.get(a.address)?.at ?? now))` in `dim`. Rows keep their existing index bookkeeping for scroll (agent lines are extra direct children; the `activeIndex` of the row itself stays correct because it's recorded before its agent lines are pushed).

- [ ] **Step 4: Agent order.** At the end of render (non-empty list path), `setAgentOrder(order)`.

- [ ] **Step 5: Check.** `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects && npm test` → check passes, tests green.

- [ ] **Step 6: Commit** `git add mods/projects/main.js && git commit -m "feat: agents under their worktree in projects sidebar"`

### Task 3: Remove the Agents panel and verify

- [ ] **Step 1: Layout.** Back up `~/.config/herdr-app/layouts/orca.json`, then remove the child with `"id": "agents"` (content `mod: "agents"`) from its column; leave the `projects` block. `herdr-app status` → `"errors": []`.

- [ ] **Step 2: Manual checks** (orca layout; each observed):
  1. A space running Claude and Antigravity shows two indented lines with icon, name, status, and (after a minute) `1m`.
  2. Make Claude ask for permission → its line's status turns `blocked` colour within ~1 s, timer restarts.
  3. Click an agent line → its pane gets focus (space switches if needed).
  4. Collapse that project while its space is active → the row and its agent lines stay.
  5. The Agents panel is gone; the agent next/previous keys (see `keys.json` `agent.next`) walk agents in sidebar order.
  6. `ctrl-shift-l` to `main` → Herdr's Agents panel is still there.
