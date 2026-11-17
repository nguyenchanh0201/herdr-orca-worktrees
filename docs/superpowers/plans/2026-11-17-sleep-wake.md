# Sleep and Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sleep a worktree's agents (each quits and its printed resume command is saved with the worktree) and wake them later in the same terminals, with 🌙 rows in the projects sidebar that stay listed even after the space is closed.

**Architecture:** Pure parsing in `mods/projects/sleep.js` (ESM) with a CJS twin in `src/sleep.js`, kept equal by a test. The helper stores records in each worktree's git dir and lists them per repo. The long-lived `projects` sidebar runs sleep/wake through `hc` (`get`, `send --if idle`, `interrupt`, `read`) on `setShared` requests from a new row menu.

**Tech Stack:** Node 24, `node:test`, git, `hc` (herdr-core CLI), Herdr.app mods.

**Spec:** `docs/superpowers/specs/2026-11-17-sleep-wake-design.md`

## Global Constraints

- Record file: `<git rev-parse --git-dir>/orca-sleep.json`, shape `{ version: 1, sleptAt, branch, agents: [{ terminal, tab, name, kind, cwd, resume, flags, command }] }`.
- Kinds and quit commands: `claude` `/exit`, `codex` `/quit`, `agy` `/quit`, `dsh` `/exit`.
- Resume patterns (full line, after stripping ANSI): codex `^codex resume [0-9a-f-]{8,}$`; agy `^agy --conversation=[A-Za-z0-9-]+$`; dsh `^DSH_TUI_RESUME_SESSION=[A-Za-z0-9-]+ dsh --profile dsh-tui$`; claude `^claude (--resume|-r) [A-Za-z0-9-]+$`.
- Fallbacks: claude `claude --resume <sessionId from ~/.claude/sessions/<pid>.json>`; codex `codex resume <id from session file>`; agy `agy --continue`; dsh `dsh-tui --continue`.
- Kept flags: codex `--no-daemon`; claude `--dangerously-skip-permissions`, `--permission-mode X`, `--model X`, `--effort X`; agy `--mode X`, `--model X`, `--effort X`; dsh none.
- Timings: `hc send` exec timeout 5 000 ms; exit poll every 500 ms up to 20 000 ms; interrupt-to-idle wait ≤ 5 000 ms; new-space lookup ≤ 3 000 ms.
- Shared keys: `orca.projects.request` adds kinds `sleep` `{ id, space, confirm }`, `wake` `{ id, worktree }`, `forget-sleep` `{ id, worktree }`; result `orca.projects.sleep` `{ id, state: "running"|"confirm"|"done"|"error", busy?, error? }`.
- Never type into a blocked agent or an unsent draft; never save a command that fails the patterns/fallbacks.
- Tests never run real agents, `hc send`, or touch real repos; use temp repos and fixtures.
- Commits: no AI co-author trailer.

## Review Focus

1. A screen where the resume line is wrapped, coloured or followed by a shell prompt must still parse; a near-miss must not — tests `parseResume real screens` / `parseResume rejects near-miss` (Task 1).
2. Waking twice (double click) must not start two copies — Task 4 Step 3 `waking` guard + manual check 5.
3. A sleeping worktree with a closed space must wake into a new space with all its agents — Task 4 Step 3 + manual check 6.
4. An agent with an unsent draft must be skipped untouched — Task 4 Step 2 (`--if idle`, 5 s cap) + manual check 4.
5. After an agent quits, `agents()` may or may not still list its terminal — verify in Task 4 Step 1 and base "awake again" detection on the foreground program.

---

## Files

- Create: `mods/projects/sleep.js`, `src/sleep.js`, `test/sleep.test.js`, `test/fixtures/sleep/*.txt`, `mods/projects/moon.svg`
- Modify: `bin/orca-wt.js`, `mods/projects/group.js`, `test/projects-group.test.js`, `mods/projects/main.js`, `mods/orca-project/main.js`

### Task 1: Parsing (`mods/projects/sleep.js` + `src/sleep.js`)

**Interfaces — Produces (same names in both files):** `agentKind(agent)`, `QUIT`, `stripAnsi(text)`, `parseResume(kind, screen) => string|null`, `fallbackResume(kind, { claudeSessionId, codexSessionId }) => string|null`, `keptFlags(kind, argv) => string[]`, `withFlags(kind, command, flags) => string`, `resumeArgv(command) => string[]`, `isValidResume(kind, resume) => boolean` (patterns or fallback shapes).

- [ ] **Step 1: Fixtures** `test/fixtures/sleep/`: `codex-exit.txt` (token usage lines, "To continue this session, run:", `codex resume 019a…` with ANSI colour codes, then a shell prompt line), `agy-exit.txt` ("Resume with -c (or command below):" then `agy --conversation=b48e…`), `dsh-exit.txt` (`DSH_TUI_RESUME_SESSION=a83addba-a0dc-45f1-be00-1654dd4ab9bd dsh --profile dsh-tui`, from the person), `claude-exit.txt` (no resume line), `near-miss.txt` (`codex resume` with no id; `agy --conversation=` empty; a sentence containing the command mid-line).
- [ ] **Step 2: Tests** `test/sleep.test.js` (load both copies; every case runs against both): `parseResume real screens` for codex/agy/dsh return exactly the command; claude fixture → `null`; `parseResume rejects near-miss` → `null` for each; bottom-most match wins when two appear; `fallbackResume` claude with id → `claude --resume <id>`, without → `null`, codex with id, agy → `agy --continue`, dsh → `dsh-tui --continue`; `keptFlags("codex", ["codex","--no-daemon"])` → `["--no-daemon"]`, claude `["claude","--model","opus","fix the bug"]` → `["--model","opus"]` (prompt dropped); `withFlags("codex","codex resume X",["--no-daemon"])` → `codex --no-daemon resume X`; dsh unchanged; `resumeArgv("DSH_TUI_RESUME_SESSION=a dsh --profile dsh-tui")` → `["env","DSH_TUI_RESUME_SESSION=a","dsh","--profile","dsh-tui"]`; `agentKind({app:"claude-code"})` → `claude`, `{program:{key:"dsh-tui"}}` → `dsh`, unknown → `null`; ESM and CJS give equal results for every case.
- [ ] **Step 3:** run → FAIL. **Step 4:** implement both files. **Step 5:** `npm test` → pass.
- [ ] **Step 6:** `git add mods/projects/sleep.js src/sleep.js test/sleep.test.js test/fixtures/sleep && git commit -m "feat: resume command parsing for sleep"`

### Task 2: Helper records and Codex session lookup

**Interfaces — Produces** (`src/sleep.js` additions + CLI): `saveSleep(worktree, record)`, `getSleep(worktree)`, `clearSleep(worktree)`, `listSleep(repos: string[]) => Record<worktree, record & { repo }>`, `codexSession(cwd, sinceMs, sessionsDir = ~/.codex/sessions) => { id } | { id: null }`. CLI: `orca-wt sleep save <worktree> <json>`, `sleep get <worktree>`, `sleep clear <worktree>`, `sleep list <repo>...`, `orca-wt codex-session <cwd> <sinceMs>`.

- [ ] **Step 1: Tests** (temp repo via `makeRepo()`): save on the linked worktree → file at its git dir (`git rev-parse --git-dir`), `get` returns it, `clear` removes it; save on the main checkout → file in `.git/`; `save` rejects a record whose `resume` fails `isValidResume` or whose shape is wrong; `list([primary])` returns both sleeping worktrees with `repo: primary` and skips a worktree without a record; `codexSession` with a temp sessions dir holding three rollout files (other cwd, same cwd before `sinceMs`, same cwd after) → the third's `payload.id`; none → `{ id: null }`; CLI `sleep list` JSON matches.
- [ ] **Step 2–4:** FAIL → implement (write atomically; `git -C <repo> worktree list --porcelain`) → `npm test` pass.
- [ ] **Step 5:** `git add src/sleep.js bin/orca-wt.js test/sleep.test.js && git commit -m "feat: sleep records and codex session lookup in orca-wt"`

### Task 3: Sidebar rows for sleeping worktrees

**Interfaces — Produces:** `group(..., opts.sleeping)` per spec: a record whose worktree has no open space adds a row `{ space: null, worktree, sleeping: record, main: false }` to its repo group after space rows, newest `sleptAt` first; a row whose space's worktree has a record gets `sleeping: record`. `label` for a no-space row = `record.branch` ?? folder basename.

- [ ] **Step 1: Tests** in `test/projects-group.test.js`: open space + record → that row `sleeping` set; record with no open space → extra row in the right repo group, `space: null`; two such rows ordered newest first; count includes them; saved-only project with a sleeping worktree gets the row; `visibleRows` keeps a sleeping active row when collapsed (unchanged rule).
- [ ] **Step 2–4:** FAIL → implement → pass.
- [ ] **Step 5: Render.** `mods/projects/moon.svg` (24×24 stroke crescent). Sleeping row: moon (13 px, `dim`) in place of the dot, label `dim`, then one dim line per saved agent (icon by kind from `knownAgents()` `run[0]`, name, `· asleep`). Activity view lists sleeping agents last, dim, with the moon. Load records: `cli(["sleep","list", ...repoPrimaries])` on start, on `orca.projects.rev` change, and when the set of open space ids changes.
- [ ] **Step 6:** `bash scripts/install.sh projects && herdr-app check ~/.config/herdr-app/mods/projects && npm test` → pass. `git add mods/projects test/projects-group.test.js && git commit -m "feat: sleeping rows in the projects sidebar"`

### Task 4: Sleep, wake and the row menu

- [ ] **Step 1: Probe (no agents touched).** With the person's permission only if needed, otherwise from docs: decide how to detect "agent exited" — `hc get <t>` `foreground.argv[0]` basename is a shell (`zsh`, `bash`, `fish`, `sh`, `-zsh`…) or `foreground.pid` changed. Write this as `agentExited(before, after)` in `sleep.js` with tests (shell argv → true; same pid → false). Note in the commit whether `agents()` keeps listing quit agents (verify during the manual check and adjust "awake again" detection to the foreground program).
- [ ] **Step 2: Sleep handler** in `projects`' request loop (`kind: "sleep"`), per spec "Sleep" steps 1–5: busy (`working`/`blocked`) without `confirm` → publish `{ id, state: "confirm", busy }` and stop; with `confirm` → `hc interrupt` each busy one, wait ≤ 5 s for idle. Per agent in parallel: `hc get --json`; capture `argv`, `pid`, `created_ms`, `cwd`; Claude `readTextFile(~/.claude/sessions/<pid>.json)` → `sessionId`; Codex `cli(["codex-session", cwd, created_ms])`; `exec("hc", ["send","--if","idle",t,QUIT[kind]], { timeout: 5000 })` (reject/timeout → skipped "has unsent text — clear it and sleep again"); poll `hc get` until `agentExited` (≤ 20 s, else "didn't quit"); `exec("hc", ["read", t, "--lines", "60"])` → `parseResume ?? fallbackResume` → `withFlags(kind, resume, keptFlags(kind, argv))`; no command → toast with name + last 5 lines. Save the successful ones with `branch: space.branch`; toast summary; bump `orca.projects.rev`; publish `{ id, state: "done" }`.
- [ ] **Step 3: Wake handler** (`kind: "wake"`): `waking` set guard per worktree; `cli(["sleep","get",worktree])`. Open space for the worktree → per agent: `hc get <terminal>` live with a shell foreground → `exec("hc", ["send", terminal, command])`; else `run("tab.new", { space, name, folder: cwd, argv: resumeArgv(command) })`. No open space → `space.new { folder: worktree, tab: first.name, argv: resumeArgv(first.command) }`, then in `check()` find the space whose place is the worktree (≤ 3 s) and `tab.new` the rest. All handed over → `sleep clear`, bump rev; failures → toast, keep the un-woken agents in the record (`sleep save` with the remainder). `kind: "forget-sleep"` → `sleep clear`, bump rev.
- [ ] **Step 4: Row menu** — `orca-project` mode `space` (popup 220×140), opened by row right-click instead of Herdr's menu, `props: { space: id|null, worktree, sleeping: bool, hasAgents: bool }`: **Sleep** (has agents, not sleeping) → request `sleep` with `confirm: false`, then the popup stays open and shows the confirm text + **Sleep anyway** / Cancel when `orca.projects.sleep` for its id says `confirm`, else closes on `running`; **Wake** (sleeping) → request `wake`, close; **Forget sleep** (sleeping, no space) → request `forget-sleep`, close; **Space menu…** (has space) → close, `openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id } } })`. Left-click a sleeping row → `space.select` (if it has a space) + request `wake`.
- [ ] **Step 5:** `bash scripts/install.sh projects orca-project && herdr-app check ~/.config/herdr-app/mods/projects && herdr-app check ~/.config/herdr-app/mods/orca-project && npm test` → pass. `git add mods/projects mods/orca-project && git commit -m "feat: sleep and wake agents from the projects sidebar"`

### Task 5: Verify in Herdr.app

- [ ] **Manual checks** (stop and ask the person; each observed):
  1. A worktree with Claude, Codex, Antigravity and DeepSeek TUI tabs, each after one exchange → right-click → Sleep → each quits, shells stay, the row shows 🌙 with four dim "asleep" lines. Note Claude's real exit text (if it printed a resume line, add its exact pattern).
  2. Click the row → each agent resumes the same conversation in its own tab; Codex runs with `--no-daemon`.
  3. Sleep while Codex is working → "Codex is working. Sleep anyway?"; Cancel leaves it running; Sleep anyway interrupts then sleeps.
  4. Type text into Claude without sending, then Sleep → Claude is skipped with "has unsent text"; your text is untouched.
  5. Double-click a sleeping row → each agent resumes once.
  6. Sleep, then close the space → the 🌙 row stays under its project; click it → the space reopens with all agents resumed.
  7. Sleep, quit and relaunch Herdr → 🌙 still shown; wake works (new tabs if the terminals were lost).
  8. Right-click a closed sleeping row → Forget sleep → the row goes; the worktree folder is untouched.
