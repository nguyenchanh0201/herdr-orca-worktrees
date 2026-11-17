# Resource Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Orca-style Resource Manager to Herdr: a `▭ 2.14 GB · >_ 5` chip in the bottom bar, and a popover with Resources and PTYs tabs.

**Architecture:**
- A new `orca-resources` mod is the chip. It samples `ps` plus `hc ls` on a timer, builds the whole snapshot with pure helpers in `tree.js`, and publishes it with `setShared("orca.resources", snapshot)`.
- A new `orca-resources-panel` mod is the popover. It only renders that snapshot, and the panel's End button is the only action that changes anything.

**Tech Stack:** Herdr.app mods (gpui-kit, gpui-base, herdr), Node 24 `node:test` with the vm harness pattern from `test/projects-mod.test.js`.

**Spec:** `docs/superpowers/specs/2026-11-17-resource-manager-design.md`

## Global Constraints

- **No Orca tools.**
  - Never call the `orca` CLI, the Orca app, or anything under `~/jimmy_dev/orca`. Orca's source was only read for reference.
  - The only programs this feature runs are `ps`, `hc` (`ls`, `get`, `kill`), and this repo's own `orca-wt info <folder>`, which finds a worktree's repo.
- **Sampling cadence:**
  - every **2000 ms** while `shared("orca.resources.open")` is true, and **5000 ms** otherwise;
  - a sample is skipped while the previous one is still running;
  - everything runs inside `cx.spawn`.
- **`ps` command:** `exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="])`. RSS is in KB.
- **Herdr terminals:** `hc ls --json` entries with `state === "live"`, whose address has no `/` and which carry the `herdr.space` label. Others appear only under **Other terminals**, in the Resources tab, with no End.
- **Pid cache:** a terminal's shell pid is looked up once per address, then cached. Use `terminals()` if it carries `pid`; otherwise use `hc get <t> --json` → `.pid`.
- **Herdr row:** processes whose `ps` command contains `/Herdr.app/` or `herdr-core`, plus their descendants, stopping at terminal shell pids. Each pid is counted once: terminals first, in `hc ls` order, then Herdr.
- **Sparkline:** 60 samples per worktree. A worktree unseen for 600000 ms is dropped.
- **Formatting:**
  - `fmtMem(kb)`: below 1 GB it shows MB with 1 decimal (`720.8 MB`); otherwise GB with 2 decimals (`1.07 GB`), where 1 GB = 1048576 KB.
  - `fmtCpu(n)`: `n.toFixed(1) + "%"`.
- **Copy, exactly as written:**
  - Title: `Resource Manager`. Buttons and tabs: `Refresh`, `Resources`, `PTYs`.
  - Summary memory label: `Σ RSS`. The fold: `Metric details`.
  - Table columns: `Name`, `CPU`, `Mem`.
  - Group rows: `Herdr` and `Other terminals`.
  - PTYs tab lines: `N Herdr terminals on this computer`, `Last observed <h:mm:ss AM/PM>`, `Select all`, `End selected (n)`, `End`.
  - The confirmation: `End N terminal(s) and their processes?`, plus ` One is running <Agent>.` when any chosen terminal's `agent` isn't one of `zsh`, `bash`, `fish` or `sh`.
- **No AI co-author trailer on commits.**

## Review Focus

1. **A process listed under two terminals,** for example a child that was re-parented, is counted once, in the first terminal in `hc ls` order. Task 1 tests this.
2. **A terminal whose shell pid is no longer in `ps`** (it exited between `hc ls` and `ps`) shows 0 and doesn't throw. Task 1 tests this.
3. **`ps` output with odd spacing or a trailing blank line** still parses. Task 1 tests this.
4. **A place that isn't a git repo** (where `orca-wt info` returns an error) becomes its own project, named after the folder. Task 2 tests this.
5. **End on a terminal that already exited** (`hc kill` exits non-zero) shows the error in the panel, and the other selected terminals still end. Task 4 tests this.

---

### Task 1: Pure snapshot helpers

**Files:**
- Create: `mods/orca-resources/tree.js` (ESM, no imports)
- Test: `test/resources-tree.test.js`

**Interfaces:**
- **Produces** (ESM exports):
  - `parsePs(text: string): Map<number, {ppid: number, cpu: number, rss: number}>`
  - `subtreeTotals(procs, roots: number[]): Map<number, {cpu, rss, pids: number[]}>`. Each pid counts toward the first root, in array order, whose subtree contains it.
  - `herdrTotals(procs, commands: Map<number, string>, stopAt: Set<number>): {cpu, rss}`. It follows the Herdr-row rule from Global Constraints.
  - `buildSnapshot({ terminals, totals, herdr, placeOf, repoOf, now }): Snapshot`, where:
    - `terminals` is `{address, pid, space, label, agent, folder}[]`;
    - `Snapshot` is `{ at, cpu, rss, count, herdr: {cpu, rss}, projects: Project[], other: Row[] }`;
    - `Project` is `{ key, name, cpu, rss, worktrees: Worktree[] }`;
    - `Worktree` is `{ key /* place path */, name, cpu, rss, terminals: Row[] }`;
    - `Row` is `{ address, pid, label, agent, cpu, rss }`.

    `count` is the number of Herdr terminals, and `cpu` and `rss` include the Herdr row. A terminal with no `space` goes into `other`.
  - `pushHistory(hist: Map<string, {points: number[], seen: number}>, key: string, value: number, now: number): void`
  - `fmtMem(kb: number): string`
  - `fmtCpu(n: number): string`
  - `isAgent(agent: string): boolean`

- [ ] **Step 1: Write the failing tests:**
  ```js
  const PS = " 10   1  0.5  1000\n 11  10  1.0  2000\n 12  11  0.0  3000\n 20   1  2.0  4000\n\n";
  test("parsePs tolerates spacing and blank lines", () => {
    const p = t.parsePs(PS);
    assert.equal(p.size, 4); assert.deepEqual(p.get(12), { ppid: 11, cpu: 0, rss: 3000 });
  });
  test("subtreeTotals sums descendants and counts each pid once", () => {
    const tot = t.subtreeTotals(t.parsePs(PS), [10, 11, 99]);
    assert.deepEqual(tot.get(10), { cpu: 1.5, rss: 6000, pids: [10, 11, 12] });
    assert.deepEqual(tot.get(11), { cpu: 0, rss: 0, pids: [] });
    assert.deepEqual(tot.get(99), { cpu: 0, rss: 0, pids: [] });
  });
  test("herdrTotals stops at terminal shells", () => {
    const procs = t.parsePs(" 5 1 1.0 100\n 6 5 0.0 50\n 7 6 3.0 999\n");
    const cmds = new Map([[5, "/Applications/Herdr.app/Contents/MacOS/Herdr"], [6, "/x/herdr-core"], [7, "/bin/zsh"]]);
    assert.deepEqual(t.herdrTotals(procs, cmds, new Set([7])), { cpu: 1, rss: 150 });
  });
  test("fmtMem and fmtCpu", () => {
    assert.equal(t.fmtMem(738099), "720.8 MB"); assert.equal(t.fmtMem(1121976), "1.07 GB"); assert.equal(t.fmtCpu(2.44), "2.4%");
  });
  test("pushHistory keeps 60 points and drops stale keys", () => {
    const h = new Map();
    for (let i = 0; i < 70; i++) t.pushHistory(h, "a", i, i);
    assert.equal(h.get("a").points.length, 60); assert.equal(h.get("a").points[0], 10);
    t.pushHistory(h, "b", 1, 700000);
    assert.equal(h.has("a"), false);
  });
  test("isAgent", () => {
    assert.deepEqual(["zsh", "bash", "fish", "sh", "claude-code", "codex"].map(t.isAgent), [false, false, false, false, true, true]);
  });
  ```
  Add a `buildSnapshot` test using two terminals in one place, one in another repo, and one with no space:
  - the projects and worktrees are summed correctly;
  - `count` is 3;
  - the no-space terminal is in `other`;
  - `rss` includes `herdr.rss`.
- [ ] **Step 2: Run** `node --test test/resources-tree.test.js`. Expected: FAIL (cannot find module).
- [ ] **Step 3: Implement** `mods/orca-resources/tree.js`. Build a children map once, then walk depth-first from each root, skipping pids already claimed.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add mods/orca-resources/tree.js test/resources-tree.test.js && git commit -m "feat: resource snapshot helpers"`

### Task 2: Chip mod and sampler

**Files:**
- Create: `mods/orca-resources/main.js`, `mods/orca-resources/mod.json` (`{"place":"none","title":"Resources"}`), `mods/orca-resources/config.js` (written by `install.sh` the same way as `orca-usage`'s, if that mod uses one), and `mods/orca-resources/chip.svg`
- Modify: `scripts/install.sh`. Add `orca-resources orca-resources-panel` to the default `MODS` list.
- Modify: `README.md`. Add the one-time layout step.
- Test: `test/resources-mod.test.js` (a vm harness copied from `test/projects-mod.test.js`'s `element`/`harness` pattern, with `exec` stubbed by command)

**Interfaces:**
- **Consumes:** everything from Task 1. Copy `placeOf` from `mods/projects/group.js` into `mods/orca-resources/place.js`, and add a test that both copies agree on the same inputs.
- **Produces:**
  - `shared("orca.resources")`: the `Snapshot`, plus `history: { [worktreeKey]: number[] }` (memory in KB) and `herdrHistory: number[]`.
  - `shared("orca.resources.refresh")`: the panel sets `{at}`; the chip samples now when it sees a newer `at`.
  - Chip render: memory glyph, `fmtMem(rss)`, `·`, `>_`, then `count`. Clicking it opens the popover exactly like `orca-usage`'s strip does: `openOverlay({mod: "orca-resources-panel", kind: "popup", frame: "none", width: 360, height: b.y - 12, at: {x: b.x + b.width - 360, y: b.y - 4 - height}, props: {height}})`.
  - `repoOf(place)`: runs `orca-wt info <place>` once per place and caches it. The project key and name come from `primary` and its basename. On `{error}`, the place is its own project, named by its basename.

- [ ] **Step 1: Write the failing harness tests:**
  - **`sample publishes a snapshot`:** stub `ps`, `hc ls --json` (two live labelled terminals and one with no label), `hc get` (the pids) and `orca-wt info` (a primary). After one sample, `shared("orca.resources").count` is 2, `projects[0].name` is the primary's basename, and `other` has 1 row.
  - **`pids are looked up once`:** after two samples, `hc get t1` was called once.
  - **`skips a sample while one is running`:** with a `ps` stub that never resolves, a second tick doesn't call `ps` again.
  - **`non-repo place becomes its own project`:** `orca-wt info` returns `{error}`, so the project name is the folder's basename.
  - **`never calls orca tools`:** across every test, no recorded `exec` command is `orca` or contains `Orca.app`.
  - **`chip text and click`:** the render texts contain `2.14 GB` (choose stub RSS values that give it) and `5`. Clicking records `openOverlay` with `mod: "orca-resources-panel"`.
  - **`placeOf copies agree`.**
- [ ] **Step 2: Run** `node --test test/resources-mod.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Use `cx.timer.every(1000, tick)`. The tick samples when its due time has passed: 2000 ms if open, 5000 ms otherwise, or immediately on a new refresh request.
  - Get `ps` commands for the Herdr row with a second call, `ps -axo pid=,comm=`, in the same sample.
  - Skip everything when `checking()`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install, add to the layout, and look:**
  1. Run `bash scripts/install.sh orca-resources && herdr-app check ~/.config/herdr-app/mods/orca-resources`. Expected: `check passed`.
  2. Read `~/.config/herdr-app/layouts/orca.json`. In the `orca-strip` row, insert `{"id": "orca-resources", "type": "block", "size": {"px": 150}, "content": {"mod": "orca-resources"}}` between `orca-usage` and the `orca-setup` block. Edit only that row.
  3. Take a screenshot with `herdr-app shot <scratchpad>/chip.png` and read it. Expected: the chip shows a GB or MB value and a terminal count matching `hc ls` (labelled, local, live).
- [ ] **Step 6: Commit:** `git add mods/orca-resources scripts/install.sh README.md test/resources-mod.test.js && git commit -m "feat: resource chip and sampler"`

### Task 3: Popover with the Resources tab

**Files:**
- Create: `mods/orca-resources-panel/main.js`, `mods/orca-resources-panel/mod.json`
- Test: `test/resources-mod.test.js`

**Interfaces:**
- **Consumes:** `shared("orca.resources")` (Task 2), and `fmtMem`/`fmtCpu`. Copy them into `mods/orca-resources-panel/fmt.js`, and add a test that the copies agree.
- **Produces:**
  - It sets `shared("orca.resources.open")` to true in `init` and to false on close.
  - Refresh sets `orca.resources.refresh`.
  - The tab is saved in `localStorage` under `resources.tab`, with values `resources` or `ptys`.
  - Sort state is `{by: "name" | "cpu" | "mem", dir}`, defaulting to mem, descending.
  - Folds use `localStorage` `resources.folded`, a list of project and worktree keys. The Herdr row starts folded.

- [ ] **Step 1: Write the failing harness tests,** with a fixed snapshot in `shared`:
  - **`header, tabs and summary`:** the texts include `Resource Manager`, `Refresh`, `Resources`, `PTYs`, the summary `fmtCpu(cpu)` and `fmtMem(rss)`, and `Σ RSS`.
  - **`rows nest project, worktree, terminal, sorted by mem`:** the texts are, in order, `HERDR-ORCA-WORKTREES`, `feat/projects-sidebar` and the bigger terminal before the smaller one. `Herdr` is last, and its children are hidden.
  - **`clicking CPU header sorts by cpu`:** the order flips as expected.
  - **`clicking a terminal row focuses it`:** `run("pane.focus", {terminal: "t1"})` is recorded.
  - **`Metric details unfolds the explanation`:** after a click, the texts include `%cpu` and `RSS`.
  - **`open flag`:** `shared("orca.resources.open")` is true after init.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Copy the outer layout from `mods/orca-usage-panel/main.js`: a transparent root of height `props().height`, bottom-aligned, that closes when pressed outside the card.
  - The card is 360 px wide.
  - Each worktree's sparkline is a 48×14 row of thin bars, normalised from the minimum to the maximum.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install and look:**
  1. Run `bash scripts/install.sh orca-resources-panel` and `herdr-app check`.
  2. Click the chip, then take a screenshot. Expected: the Resources tab with real projects.
- [ ] **Step 6: Commit:** `git add mods/orca-resources-panel test/resources-mod.test.js && git commit -m "feat: resource manager popover, resources tab"`

### Task 4: PTYs tab with End

**Files:**
- Modify: `mods/orca-resources-panel/main.js`
- Test: `test/resources-mod.test.js`

**Interfaces:**
- **Consumes:** the snapshot rows (Task 2) and the panel (Task 3).
- **Produces:**
  - A checkbox set of selected addresses, holding only Herdr terminals.
  - `endTerminals(addresses, cx)` asks once with the confirmation copy, then runs `hc kill <t>`, at most 4 at a time.
    - A failure shows an inline line, `<label>: <stderr>`, and doesn't stop the others.
    - Afterwards it clears the selection and requests a refresh.
  - Unfolding a row runs `hc get <t> --json` once and shows the address, PID, folder, `foreground.argv.join(" ")`, and the start time from `created_ms`.

- [ ] **Step 1: Write the failing harness tests:**
  - **`PTYs tab lists only Herdr terminals with counts`:** it shows `2 Herdr terminals on this computer`, the project and worktree headings with their counts, and no `Other terminals` row.
  - **`Select all then End selected asks once and kills each`:** the confirmation text reads `End 2 terminals and their processes? One is running Claude Code.`. After confirming, `hc kill t1` and `hc kill t2` are recorded, then a refresh request.
  - **`a failed kill shows inline and others still end`:** `hc kill t1` exits 1 with stderr `gone`. The texts include `gone`, and `hc kill t2` was still called.
  - **`End selected is disabled at 0`.**
  - **`↗ jumps to the terminal`:** it records `run("pane.focus", {terminal: "t1"})`.
  - **`unfolding a row shows details`:** with the `hc get` stub, the texts include `t1` and the argv string.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The confirmation is an inline bar inside the card, with Cancel and End, so no second popup is needed.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Install and check by hand:**
  1. Run `bash scripts/install.sh orca-resources-panel` and `herdr-app check`.
  2. Start a throwaway terminal in a Herdr space. Ask the person to open PTYs, check it, End it, and confirm. Expected: it disappears within 2 s.
- [ ] **Step 6: Commit:** `git add mods/orca-resources-panel test/resources-mod.test.js && git commit -m "feat: resource manager PTYs tab with end"`
