# Sleep and wake agents like Orca — design (Herdr.app)

Date: 2026-11-17. The last of the Orca features listed at the start
(sidebar, agent picker, usage, sleep). Builds on the projects sidebar and the
chrome polish spec.

## Intent

Put a worktree's agents to sleep and wake them later where they were, like
Orca's "Sleep Workspace". The person's idea: every agent already tells you how
to resume when it quits, so **sleep = quit each agent and keep the resume
command it prints; wake = type that command back into the same terminal.**
The space stays in the sidebar, dimmed with a 🌙 (Orca's sleeping row).

## Goals

1. Right-click a worktree row → **Sleep**: every agent in that space quits
   cleanly and its resume command is saved with the worktree.
2. The row shows 🌙, dims, and lists its sleeping agents as dim lines.
3. Clicking a sleeping row (or right-click → **Wake**) shows the space and
   resumes each agent in its own terminal.
4. Works for Claude, Codex, Antigravity (`agy`) and DeepSeek TUI.

## Non-goals

- Auto-sleep on idle (experimental and off by default in Orca).
- Closing the space or its shells on sleep (the person chose: the space stays).
- Restoring the old screen/scrollback (Herdr can't keep a killed terminal's
  screen; the agent restores its own conversation).
- Sleeping sub-agents or non-agent programs; sleeping remote-machine spaces.

## Anti-goals

- Saving a command that isn't a recognised resume command (garbage replayed
  into a shell).
- Losing work silently: an agent mid-turn is never quit without asking.
- Running a wake twice for one sleep (two resumed copies of an agent).

## Constraints

- Mods can't write files outside `~/.config/herdr-app`; records go through the
  `orca-wt` helper. Mods talk to terminals with `hc` (`exec("hc", …)`):
  `hc get <t>` (JSON: `foreground.{argv,pid}`, `status`, `state`, `cwd`),
  `hc send <t> <text>` (paste + Enter), `hc interrupt <t>`, `hc read <t>
  --lines N`.
- Agents run in the person's interactive shell, which stays open after the
  agent exits (Herdr behaviour), so the same terminal can take the resume
  command.
- Overlays lose their tasks when closed, so the long-lived `projects` sidebar
  runs sleep and wake (request pattern, as clone and create).

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | Quit each agent, parse the resume command it prints (fallbacks where it doesn't), keep the space and shells, wake by typing the command into the same terminal | Agent-agnostic; frees the agent processes (most of the memory); shells and tabs stay |
| B | Find session ids from session files and kill terminals (Orca's hook-based way) | Needs per-agent file sleuthing; agy's conversations have no folder to match |
| C | Close the whole space on sleep, reopen on wake | Frees a little more; loses shell tabs and their history; slower wake |

The person proposed A and chose to keep the space.

## Design

### What each agent prints (verified from binaries / the person)

| Agent | Detected by (`agents()` `app` / program key) | Quit | Resume line on exit | Fallback |
|---|---|---|---|---|
| Codex | `codex` | `/quit` | `To continue this session, run:` then `codex resume <id>` | session id read **before** quitting: newest `~/.codex/sessions/**/rollout-*.jsonl` whose first line's `payload.cwd` is the terminal's cwd and whose `payload.timestamp` is after the terminal's `created_ms` (helper `orca-wt codex-session <cwd> <sinceMs>`) → `codex resume <id>` |
| Antigravity | `agy`, `antigravity` | `/quit` | `Resume with -c (or command below):` then `agy --conversation=<id>` | `agy --continue` |
| DeepSeek TUI | `dsh-tui` | `/exit` | `DSH_TUI_RESUME_SESSION=<id> dsh --profile dsh-tui` (the person's real exit screen, dsh-tui 0.18.0 / profile 0.20.1; authoritative over Orca's `dsh-tui --backend=dsh --resume <id>`) | `dsh-tui --continue` (`dsh-tui --help`: "-c, --continue = --resume", resume last; sessions are per folder) |
| Claude | `claude-code`, `claude` | `/exit` | unconfirmed; matched if printed | `claude --resume <id>` with `id` = `sessionId` from `~/.claude/sessions/<pid>.json`, read **before** quitting (the file goes when Claude exits) |

The builder confirms Claude's exit text on a real session and adds its
pattern if it prints one.

### Pure parsing (`mods/projects/sleep.js`, ESM, tested with `node --test`)

- `agentKind(agent) => "claude"|"codex"|"agy"|"dsh"|null` from `agent.app`
  then `agent.program.key`.
- `QUIT = { claude: "/exit", codex: "/quit", agy: "/quit", dsh: "/exit" }`.
- `parseResume(kind, screenText) => string | null`: strip ANSI escapes, scan
  lines bottom-up, return the first full match of that kind's pattern
  (ids: `[A-Za-z0-9-]+`):
  - codex `^codex resume [0-9a-f-]{8,}$`
  - agy `^agy --conversation=[A-Za-z0-9-]+$`
  - dsh `^DSH_TUI_RESUME_SESSION=[A-Za-z0-9-]+ dsh --profile dsh-tui$`
  - claude `^claude (--resume|-r) [A-Za-z0-9-]+$`
  Anything else → `null` (never a partial or free-form line).
- `fallbackResume(kind, { claudeSessionId }) => string | null` per the table.
- `resumeArgv(command) => string[]`: split on spaces; a first word with `=`
  becomes `["env", that, ...rest]`.
- `keptFlags(kind, argv) => string[]`: the launch flags worth keeping from the
  agent's original `foreground.argv` (captured before quitting) — codex
  `--no-daemon` (Herdr starts Codex with it so sessions don't share one
  daemon); claude `--dangerously-skip-permissions`, `--permission-mode X`,
  `--model X`, `--effort X`; agy `--mode X`, `--model X`, `--effort X`; dsh
  none. Prompts and other positional args are never kept.
- `withFlags(kind, command, flags) => string`: inserts the kept flags right
  after the program word (`codex --no-daemon resume <id>`, `claude
  --model opus --resume <id>`); dsh's env-prefixed line is left as is. The
  saved `command` is the result; the record also keeps `resume` (the bare
  matched line) and `flags` separately so the helper validates `resume`
  against the patterns.

### Sleep record (helper, `src/sleep.js` + `orca-wt sleep …`)

Stored at `<git rev-parse --git-dir of the worktree>/orca-sleep.json` (beside
`orca-setup-done`; per worktree, invisible to `git status`, removed with the
worktree):

```json
{ "version": 1, "sleptAt": 1794890000000,
  "agents": [ { "terminal": "t1w", "tab": "tb…", "name": "Claude Code",
                "kind": "claude", "cwd": "/…/feat-x",
                "command": "claude --resume 3f2c…" } ] }
```

- `orca-wt sleep save <worktree> <json>` (validates shape; every `command`
  must pass the same patterns or fallbacks — the helper has the CJS twin of
  `sleep.js`'s patterns, kept in sync by a test, as `format.js` is).
- `orca-wt sleep get <worktree>` → the record or `{ sleeping: false }`.
- `orca-wt sleep clear <worktree>`.
- `orca-wt sleep list <worktree>...` → `{ <worktree>: record }` for those
  that sleep (one call per refresh for every open local space).

### Sleep (run by `projects`, request `{ id, kind: "sleep", space }`)

1. Agents = `agents()` in that space whose `agentKind` isn't null. None →
   toast "No agents to sleep".
2. Any with status `working` or `blocked` (waiting on a permission or a
   question) → the request first came from the row menu with `confirm:
   false`: `projects` publishes `{ id, state: "confirm", busy: [{ name,
   status }] }` and the menu popup shows "Codex is working. Sleep anyway?" /
   "Claude is waiting for you. Sleep anyway?" with **Sleep anyway** / Cancel
   (re-sends with `confirm: true`). Confirmed → `hc interrupt <t>` for those,
   then wait (≤ 5 s) until `hc get` status is `idle`.
3. Per agent, in parallel:
   - `hc get <t>` → `pid` = `foreground.pid`; Claude → `readTextFile`
     `~/.claude/sessions/<pid>.json` → `sessionId` (missing → null).
   - Before quitting: capture `foreground.argv` (for `keptFlags`) and, for
     Codex, the session-file fallback id.
   - `hc send --if idle <t> <QUIT[kind]>` with `exec` timeout 5 s. Not idle,
     or the send doesn't return in 5 s (`hc send` waits for an unsent draft
     the person typed) → that agent is skipped and reported "has unsent text —
     clear it and sleep again"; nothing was sent to it.
   - Poll `hc get <t>` every 500 ms up to 20 s until the foreground program
     is no longer the agent (its `argv[0]` basename is a shell, or `pid`
     changed) — the agent has exited.
   - `hc read <t> --lines 60` → `parseResume` ?? `fallbackResume`.
   - Didn't exit in 20 s → reported "didn't quit"; it keeps running and isn't
     in the record.
   - Exited but no command from the screen or a fallback (should be rare
     after the Codex fallback) → toast with its name and the last 5 screen
     lines, so the person can resume by hand; not in the record.
4. `orca-wt sleep save` with the agents that produced a command. Toast:
   "Slept 2 agents" or "Slept 1 of 2 agents — Codex didn't quit".
5. Bump `orca.projects.rev` so rows refresh.

### Sidebar

- `projects` loads `orca-wt sleep list` for every open local space's worktree
  on start, on `orca.projects.rev` change, and when the set of open spaces
  changes (no polling).
- Sleeping row: 🌙 (`mods/projects/moon.svg`, stroke icon) in place of the
  status dot, label in `dim`, and one dim line per saved agent:
  `icon  Codex  · asleep` (icon from `knownAgents()` by kind).
- A row with a record whose terminals are running agents again (someone
  resumed by hand) → clear the record (`sleep clear`) on the next refresh.
- **Right-click a row** now opens our row menu (`orca-project` mode `space`,
  popup 220×140): **Sleep** (only when it has agents and isn't asleep) or
  **Wake** (when asleep), then **Space menu…** which opens Herdr's shipped
  space menu as today (`mod: "menu"`, `props: { tab: "space", target: { id } }`).
- **Left-click a sleeping row** → `space.select` + wake (Orca wakes on
  activation). Header Activity view lists sleeping agents last, dim, 🌙.

### Wake (run by `projects`, request `{ id, kind: "wake", space }`)

1. Read the record; none → nothing. Mark this worktree "waking" in memory
   (ignore a second wake request until done).
2. Per agent: `hc get <terminal>`: live and its foreground is a shell →
   `hc send <terminal> <command>`. Otherwise (terminal gone after a restart or
   reboot) → `run("tab.new", { space, name, folder: cwd, argv:
   resumeArgv(command) })`.
3. `orca-wt sleep clear` once every agent was handed its command; bump rev.
   Any failure → toast with the agent name; the record keeps the agents not
   woken.

### Install

`orca-project` gains mode `space`; `mods/projects/moon.svg`; no new mod.

## Testing

- `node --test`: `parseResume` per kind (real exit-screen samples with ANSI
  colour codes, extra text before/after, the `codex resume` line on the line
  after "To continue this session, run:", a near-miss line rejected, bottom-
  most match wins); `fallbackResume` (Claude with/without session id, agy,
  dsh, codex → null); `resumeArgv` (`env` prefix for dsh, plain split
  otherwise); `agentKind` from `app` and `program.key`; helper `sleep save /
  get / clear / list` on a temp repo and linked worktree (file lands in the
  git dir, invalid command rejected, list only returns sleeping ones); the
  CJS/ESM pattern copies match.
- `herdr-app check` on `projects` and `orca-project`.
- Manual (the person): one worktree with Claude, Codex, Antigravity and
  DeepSeek TUI tabs → Sleep → each quits, row shows 🌙 and four dim agent
  lines, shells stay; click the row → each resumes the same conversation in
  the same tab; Sleep while Codex is working → "Sleep anyway?"; quit Herdr
  while asleep, relaunch, click → resumes (new tabs if terminals were lost);
  Claude's real exit text captured (adjust its pattern if it prints one).

## Review notes

Builder check (2026-11-17) — settled as my calls: keep useful launch flags on
wake (`--no-daemon` for Codex, permission/model/effort flags); the person's
real DeepSeek exit line is authoritative; `blocked` agents get the same
"Sleep anyway?" as `working`; `hc send --if idle` with a 5 s cap skips agents
that have an unsent draft instead of typing into it; Codex gets a
session-file fallback read before quitting, and any agent that exits with no
resume command produces a toast with its last screen lines. To verify while
building: whether `agents()` keeps listing a terminal after its agent quits
(if it does, "running agents again → clear the record" must check the
foreground program, not `agents()`).

## Left to the builder

- Exact dim/🌙 styling within theme colours; poll interval within 300–700 ms.
