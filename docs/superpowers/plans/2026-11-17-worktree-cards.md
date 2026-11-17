# Worktree Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each worktree in the projects sidebar becomes an Orca-style card whose agents fold into a one-line strip and unfold into a list.

**Architecture:** Pure helpers (`topStatus`, `agentSummary`, `STATUS_GLYPH`) go in `mods/projects/group.js`, unit-tested. `mods/projects/main.js` wraps today's row in a card and draws the strip or the list from `agents()` and the sleep records it already has. The fold state lives in `localStorage`.

**Tech Stack:** Herdr.app mod (gpui-kit, gpui-base, herdr), Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-17-worktree-cards-design.md`

## Global Constraints

- **Status urgency:** blocked > working > done > idle. Glyphs: blocked `!`, working `●`, done `✓`, idle `○`. Each glyph is coloured `t[status]` (fall back to `t.unknown`).
- **Folded by default.** The open state is `localStorage` `projects.agentsOpen`: a JSON array of worktree paths, read in `init` and written on toggle, with every access in try/catch. Nothing unfolds by itself.
- **The strip shows at most 5 agent icons**, then `+N`.
- **Main checkout badge:** text `main`, replacing ★. Show a machine chip only when `space.machine` is set.
- **Card height changes only on a click, or when agents come or go.** Never on hover.
- **No new CLI or network calls.**
- **Activity view:** unchanged.
- **Commits:** no AI co-author trailer.

## Review Focus

- **A worktree with agents of mixed status** (one blocked, one done): the folded strip shows `!` in the blocked colour. Task 1 tests `topStatus`; Task 2's harness test checks the strip glyph.
- **A worktree with more than 5 agents:** 5 icons plus `+N`. Task 1 tests `agentSummary`.
- **The active space's card after a fold toggle:** `scroll_to_item` still points at the active card. Task 2's harness test checks the `activeIndex` it passes.
- **A sleeping worktree with no live space:** the card still renders the dimmed strip with a moon, and clicking the title still wakes it. Task 2's harness test.
- **An unknown or missing `a.status`:** the glyph falls back to `○`, coloured `t.unknown`, with no crash. Task 1 tests that `topStatus` ignores unknown statuses.

---

### Task 1: Status helpers

**Files:**
- Modify: `mods/projects/group.js`
- Test: `test/projects-group.test.js`

**Interfaces:**
- Produces (ESM exports from `group.js`):
  - `STATUS_GLYPH`: `{ blocked: "!", working: "●", done: "✓", idle: "○" }`
  - `topStatus(agents: {status?: string}[]): "blocked" | "working" | "done" | "idle" | null`. Returns the most urgent known status, ignoring unknown or missing ones, and `null` when none are known.
  - `agentSummary(agents: any[], max = 5): { icons: any[], more: number }`. `icons` is the first `max` agents; `more` is `Math.max(0, agents.length - max)`.

- [ ] **Step 1: Write the failing tests** in `test/projects-group.test.js` (it already loads `g = await import("../mods/projects/group.js")`):

```js
test("topStatus picks the most urgent status", () => {
  assert.equal(g.topStatus([{ status: "done" }, { status: "blocked" }, { status: "working" }]), "blocked");
  assert.equal(g.topStatus([{ status: "idle" }, { status: "working" }]), "working");
  assert.equal(g.topStatus([{ status: "idle" }, { status: "done" }]), "done");
  assert.equal(g.topStatus([{ status: "weird" }, {}]), null);
  assert.equal(g.topStatus([]), null);
});
test("agentSummary caps icons at 5", () => {
  const a = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(g.agentSummary(a), { icons: [1, 2, 3, 4, 5], more: 2 });
  assert.deepEqual(g.agentSummary([1, 2]), { icons: [1, 2], more: 0 });
  assert.deepEqual(g.agentSummary([1, 2, 3], 2), { icons: [1, 2], more: 1 });
});
test("STATUS_GLYPH", () => {
  assert.deepEqual({ ...g.STATUS_GLYPH }, { blocked: "!", working: "●", done: "✓", idle: "○" });
});
```

- [ ] **Step 2: Run them**: `node --test test/projects-group.test.js`. Expected: FAIL (`g.topStatus is not a function`).
- [ ] **Step 3: Implement** the three exports in `mods/projects/group.js`.
- [ ] **Step 4: Run all tests**: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit**: `git add mods/projects/group.js test/projects-group.test.js && git commit -m "feat: agent status helpers for worktree cards"`

### Task 2: Worktree cards in the sidebar

**Files:**
- Modify: `mods/projects/main.js` (`init`, the Projects branch of `render()` around lines 995–1017, `renderRow`, and the sleeping and live agent row renderers)
- Test: `test/projects-mod.test.js` (uses the existing `harness`, `nodes` and `texts` helpers)

**Interfaces:**
- Consumes: `topStatus`, `agentSummary` and `STATUS_GLYPH` from Task 1 (add them to the existing `group.js` import line).
- Produces:
  - `this.agentsOpen: Set<string>` (worktree paths)
  - `toggleAgents(worktree: string, cx)`: flips the path, saves the list, then calls `cx.notify()`
  - `renderCard(row, rowAgents, sleepingAgents, t, now, opts): element`

- [ ] **Step 1: Write the failing harness tests** in `test/projects-mod.test.js`. Set `h.state.spaces`/`h.state.agents` and saved projects so that one repo group has a space `s1` (folder `/r`, `active: true`) with agents `[{address: "a1", space: "s1", pane: "p1", status: "done", program: {name: "Claude", icon: "icons/claude.svg"}}, {address: "a2", space: "s1", pane: "p2", status: "blocked", program: {name: "Codex", icon: "icons/codex.svg"}}]`. Build it with the fixtures the existing render tests in that file use. Then:
  - **`worktree card folds agents into a strip by default`**: render. The texts contain `!` (the blocked glyph) and `›`. They don't contain `Done - Claude`. There are exactly 2 `image`/`svg` agent icons in the strip.
  - **`clicking the strip unfolds and remembers it`**: call the strip's `on_click`. `h.view.agentsOpen.has("/r")` is true. `localStorage.setItem` was called with `projects.agentsOpen` and `["/r"]`. Re-render: the texts contain `2 agents`, `Blocked - Codex` and `Done - Claude`. Clicking the `2 agents` row folds it again.
  - **`agent row click focuses its pane`**: unfolded, the `Done - Claude` row's `on_click` runs `run("pane.focus", { pane: "p1" })`. Make the harness's `run` record its calls.
  - **`main checkout shows the main badge instead of a star`**: the texts contain `main` and not `★`.
  - **`card without agents has no strip`**: with no agents, the texts contain neither `›` nor `agents`.
  - **`sleeping worktree card shows a dimmed strip with a moon`**: a sleeping row with `sleeping.agents = [{kind: "claude", name: "Claude"}]` renders `svg("mods/projects/moon.svg")` in the strip. Clicking the title still sets `orca.projects.request` with `kind: "wake"`.

  The harness's `localStorage` stub must record `setItem` calls for the second test. Extend the stub in place.
- [ ] **Step 2: Run them**: `node --test test/projects-mod.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: State.** In `init`, set `this.agentsOpen = new Set(JSON.parse(localStorage.getItem("projects.agentsOpen") || "[]"))` (wrapped in try/catch, empty on error). Add `toggleAgents(worktree, cx)` to match the Interfaces block.
- [ ] **Step 4: Card.** `renderCard` returns a `v_flex`, with:
  - id `card-${space?.id ?? row.worktree}`, `rounded(8)`, `border(1)`, `border_color(t.border)`, `p(4)`, `gap(4)`, `mb(6)`;
  - `bg(t.selected)` when the space is active.

  Its children:
  1. **Title line:** today's `renderRow` output, with the ★ child replaced by a `main` badge (`border(1)`, `rounded(4)`, `px(5)`, `text_size(11)`, `text_color(t.muted)`). When `space?.machine`, add a chip in the same style with the machine name.
  2. **If there are no agents** (live and sleeping): nothing more.
  3. **Folded:** a strip `h_flex` (id `strip-${worktree}`, `h(24)`, `px(8)`, `gap(6)`, `rounded(6)`, `bg(t.hover)`, `cursor_pointer`, `on_click` → `toggleAgents`). It holds:
     - the glyph `STATUS_GLYPH[topStatus(live)]` in `t[status]`, or the moon svg (`t.dim`) when sleeping;
     - then the icons from `agentSummary`: `agentIcon` for live agents, `sleepingAgentIcon` for sleeping ones;
     - then `+N` (`t.dim`) when `more > 0`;
     - then `div().flex_1()`, then `›` (`t.dim`).
  4. **Unfolded:**
     - A header row (id `agents-head-${worktree}`, `h(24)`, `px(8)`, `on_click` → `toggleAgents`) reading `"${n} agent${n === 1 ? "" : "s"}"` in muted text, with `⌄` on the right.
     - Then one row per live agent: the glyph `STATUS_GLYPH[a.status] ?? "○"` coloured `t[a.status] ?? t.unknown`, then `agentIcon`, then the text `"${Status} - ${a.program?.name ?? a.app ?? ""}"`, where `Status` is the status with its first letter capitalised. Then the elapsed time on the right. Clicking the row runs `pane.focus`, as `renderAgent` does today.
     - Sleeping agents keep `renderSleepingAgent`.
- [ ] **Step 5: Render loop.** In the Projects branch, replace the push of `renderRow` and the agent rows with a single `children.push(this.renderCard(...))`. `activeIndex` becomes that card's index, and `order.push(a.address)` stays for every live agent, folded or not. Delete `renderAgent` if nothing uses it any more. Keep `renderActivityAgent`.
- [ ] **Step 6: Run all tests**: `npm test`. Expected: all pass. Fix any existing render test that asserted the old flat agent rows or ★, to match the spec.
- [ ] **Step 7: Install and look**: `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects`. Expected: `check passed`. Then `herdr-app shot <scratch>/cards.png` and read the image. Expected, if the sidebar is on the Projects view (otherwise ask the person to switch to it): folded cards, each with a strip; the feat/projects-sidebar card shows the `main` badge.
- [ ] **Step 8: Manual check** (ask the person):
  1. A card's strip shows the agent icons; click it → "N agents" with "Done - Claude" rows; click the header → it folds again; the state survives a Herdr restart.
  2. Hovering never changes a card's height.
  3. Clicking a card's title selects the space; clicking an agent row focuses it.
- [ ] **Step 9: Commit**: `git add mods/projects/main.js test/projects-mod.test.js && git commit -m "feat: orca-style worktree cards with fold-out agents"`
