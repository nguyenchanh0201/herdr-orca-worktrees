# Usage meters like Orca — design (Herdr.app)

Date: 2026-11-17. Fourth Orca feature (after the projects sidebar, agent
picker and sleep is still to come). Mimics Orca's status-bar usage chips
(`orca/src/renderer/src/components/status-bar/usage/`,
`orca/src/main/rate-limits/`).

## Intent

See how much of each subscription's limits is used — Claude, Codex,
Antigravity (`agy`) — without leaving Herdr, the way Orca's status bar shows
it: a chip per agent with its most-used window and time until reset, and a
click-open panel with every window.

## Goals

1. Chips in the bottom `orca` strip, one per available provider:
   icon + `{pct}% {time until reset}` of its most-used window (e.g.
   `42% 3h 12m`); named buckets read `{name} {pct}%`.
2. Click a chip → popup "Usage · all agents": per provider every window as
   `5h · resets in 3h 35m` + coloured bar + `42%`, a refresh button, and the
   last-checked time.
3. Refresh every 15 min (never within 5 min of the last fetch unless the
   refresh button is pressed); a reading older than 30 min counts as stale.
4. States like Orca: unavailable (not installed / not signed in) → chip hidden;
   first fetch pending → icon + `···`; error with old data → old numbers + `⚠`;
   error without data → icon + `⚠`.

## Non-goals

- Orca's Detailed mode, used/remaining switch, multiple accounts, Codex reset
  credits, the Claude statusline hook, Gemini CLI and other providers,
  token/cost history.
- DeepSeek (`dsh-tui`): pay-per-use, no subscription windows.
- Refreshing Claude's OAuth token (Orca doesn't either).

## Anti-goals

- The Claude token leaving the helper for anywhere but `api.anthropic.com`,
  being logged, cached to disk, or put in `setShared`.
- Spending quota to measure quota: never run `agy` below 1.1.11, never pass
  `--disable-slash-commands` (agy would send `/usage` as a billed prompt).
- A busy strip: no animation timers; no polling faster than the 15 min rule.
- Editing shipped mods or `layouts/main.json`.

## Constraints

- Mods are gpui-kit JS without Node; `exec` runs a program to completion (no
  stdin conversation), so fetching lives in the Node helper `bin/orca-wt.js`
  (`orca-wt usage`), tested with `node --test`.
- `herdr-app check` passes for every mod; `init()` returns early when
  `checking()`; overlay mods draw nothing without `props().overlay`.
- Closing an overlay cancels its tasks (Herdr AGENTS.md "Cleanup"), so the
  long-lived strip mod owns fetching; the popup only reads shared data and
  sends a refresh request.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (picked)** | New `orca-usage` mod beside `orca-setup` in the bottom strip | One mod per idea; setup/remove code untouched; one layout edit |
| B | Chips inside `orca-setup` | No layout edit; one mod doing two jobs |
| C | Clone Herdr's `workspace-status` bar and add chips | Where Orca puts them, but a fork of a shipped mod |

The person asked to mimic Orca and handed me the how; A is my pick.

## Design

### Helper: `orca-wt usage` (`src/usage/*.js`)

Prints `{ providers: Provider[] }`, all three fetched in parallel, overall
under 45 s.

```
Provider = { id: "claude" | "codex" | "agy",
             status: "ok" | "unavailable" | "error",
             error?: string,            // short, human-readable
             windows: Window[],         // [] unless ok
             fetchedAt: number,         // ms epoch
             manualOnly?: true,         // agy signed out: don't auto-poll it until a manual refresh
             stopAsking?: true }        // agy ran /usage as a prompt: never ask again this session
Window   = { label: string,             // "5h" | "Weekly" | "Fable" | bucket name
             minutes: number,           // 300 | 10080 | 0 (named bucket)
             usedPercent: number,       // 0–100, rounded
             resetsAt: number | null }  // ms epoch
```

`orca-wt usage --only <id>` fetches one provider (tests, debugging);
`--skip <id>` (repeatable) leaves one out (returned as its last state is
the mod's job, so a skipped provider is simply absent from the output).

**Claude** (`src/usage/claude.js`)
- Token: `security find-generic-password -s "Claude Code-credentials" -a
  <account> -w` where account = `$USER` if it matches `^[a-zA-Z0-9._-]+$`,
  else `claude-code-user`. Output is JSON; token =
  `claudeAiOauth.accessToken`. Lookup order, as Orca: if `CLAUDE_CONFIG_DIR`
  is set, first the item `Claude Code-credentials-<first 8 hex of
  sha256(<that dir>)>`; then `Claude Code-credentials`; then the file
  `~/.claude/.credentials.json` (same JSON). All missing → `unavailable`
  ("Not signed in").
  `security` failing for any other reason (e.g. access denied) → `error`
  ("Allow keychain access for Claude usage").
- Request: `GET https://api.anthropic.com/api/oauth/usage`, headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `User-Agent: claude-code/2.1.0`; 10 s timeout (Node `fetch` +
  `AbortSignal.timeout`).
- 401/403 → `error` "Updates the next time Claude runs"; 429 → `error`
  "Rate limited"; other non-2xx / network → `error` with the status.
- Mapping: `five_hour` → `5h` (300), `seven_day` → `Weekly` (10080); each
  window's % = `utilization` ?? `used_percentage`; `resets_at` ISO or epoch
  (number > 1e10 → ms, else seconds). Fable, first found: `limits[]` entry
  with `kind === "weekly_scoped"` and `scope.model.display_name` (case-
  insensitive) `"fable"` (uses `percent`), else `fable_weekly`,
  `fable_seven_day`, `seven_day_fable` → `Fable` (10080). Missing windows
  are skipped.

**Codex** (`src/usage/codex.js`)
- Spawn `codex -c approval_policy=never -c features.plugins=false -s
  read-only -a never app-server` (ENOENT → `unavailable` "Not installed").
- Newline-delimited JSON-RPC on stdin/stdout: send
  `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":
  {"name":"orca-wt","version":"1.0.0"}}}`; on the `id:1` reply send
  `{"jsonrpc":"2.0","method":"initialized","params":{}}` then
  `{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}`;
  on the `id:2` reply map and kill the process. Timeouts as Orca: 30 s for
  the `initialize` reply (a cold `app-server` start is slow), then 10 s for
  the `account/rateLimits/read` reply → kill, `error` "Codex did not answer". JSON-RPC error → `error` with its
  message (`unavailable` "Not signed in" when it mentions auth/login).
- Mapping: `rateLimits.primary` / `.secondary`, each `{ usedPercent,
  windowDurationMins, resetsAt }` (`resetsAt` epoch seconds). Window by
  duration ±1 min: 300 → `5h`, 10080 → `Weekly`; unknown → primary `5h`,
  secondary `Weekly`. Null windows skipped.

**Antigravity** (`src/usage/agy.js`)
- `agy --version` (ENOENT → `unavailable` "Not installed"); version below
  1.1.11 → `unavailable` "Update agy to show usage".
- Run `agy -p /usage --output-format json --print-timeout 20s` with env
  `AGY_CLI_DISABLE_AUTO_UPDATE=true`, 30 s timeout. Parse each stdout line
  starting with `{`; use the first with `command.name === "usage"`:
  - `status: "SUCCESS"` → for each `groups[].buckets[]` not `disabled`:
    `usedPercent = round((1 - remaining_fraction) * 100)`,
    `minutes` = 10080 for `window: "weekly"`, 300 for `"5h"`, else 0,
    `label` = group name, or `"<group> · <bucket name>"` when the group has
    more than one bucket; `resetsAt` = `reset_time` parsed.
  - `status: "ERROR"` → `error` with its `error` text.
  - Rules when there is no usage reading, in Orca's order
    (`orca/src/main/rate-limits/providers/antigravity/antigravity-usage-fetcher.ts:269-290`):
    1. A stdout JSON line with `num_turns > 0` or a `conversation_id` (agy
       answered `/usage` as a billed prompt) → `unavailable` "agy doesn't
       support /usage" with `stopAsking: true`. Only this case stops asking —
       a timeout, crash or 429 is an ordinary `error` and is retried.
    2. stdout+stderr (lower-cased) contains one of Orca's signed-out phrases
       (`not logged into antigravity`, `not logged in`, `not signed in`,
       `not authenticated`, `not-authenticated`, `unauthenticated`,
       `run agy login`, `please sign in`, `please log in`,
       `sign in to antigravity`, `no credentials`, `authentication required`)
       → `unavailable` "Sign in with agy" with `manualOnly: true`: a signed-out
       `/usage` can open a sign-in browser, so it must not run every 15 min.
    3. Otherwise → `error` "Couldn't read agy usage".
  - The helper is a fresh process each run and remembers nothing; the strip
    mod keeps `stopAsking` / `manualOnly` per session and passes
    `--skip agy` (new CLI flag) to `orca-wt usage` while either holds.
    `manualOnly` is cleared by the popup's refresh button; `stopAsking` only
    by restarting Herdr.

### Strip mod `mods/orca-usage/` (`mod.json`: `{ "place": "none", "title": "Usage" }`)

- **Layout.** In `~/.config/herdr-app/layouts/orca.json` the bottom block
  (`content.mod: "orca-setup"`, 28 px) becomes a row `{ "id": "orca-strip",
  "type": "row", "size": { "px": 28 }, "children": [orca-setup block
  (weight 1), { "id": "orca-usage", "type": "block", "size": { "px": 420 },
  "content": { "mod": "orca-usage" } }] }`. Chips are right-aligned inside
  their block; if they don't fit, the lowest-used chips are dropped first.
- **Fetching.** `init` → fetch now; `cx.timer.every(60000)` → fetch if 15 min
  passed since the last fetch. Also fetch when
  `shared("orca.usage.refresh")` changes and 5 min have passed — or always,
  when the request says `force: true` (the popup's refresh button). One fetch
  at a time. `exec(node, [cli, "usage"], { timeout: 60000 })`; a failed
  `exec` keeps the old data and marks every provider `error`.
- **Merging.** Keep the last `ok` windows per provider; a later `error` keeps
  them and sets the error (Orca: old numbers + ⚠). `unavailable` clears them.
- **Publishing.** After each fetch, `setShared("orca.usage.data", { providers,
  fetchedAt, fetching: false })` (also `fetching: true` while running), so the
  popup redraws.
- **Chip.** For each provider not `unavailable`, in the order claude, codex,
  agy: icon (from `knownAgents()` — the entry whose `run[0]` is `claude`,
  `codex` or `agy`; `tint` → `svg`, else `image`, 13 px; fallback the
  provider name), then the headline = window with the highest `usedPercent`:
  `minutes > 0` → `{pct}% {until(resetsAt) || label}`, named bucket →
  `{label} {pct}%`. No data yet → `···`. `ok` with no windows (e.g. Codex on
  an API key, every agy bucket disabled) → icon + `--`, as Orca's faded
  "no limits" chip; the popup says "No limits reported". Has error → `⚠` (in `t.blocked`)
  after the text. Stale (`fetchedAt` older than 30 min) → text in `dim`.
  Text `muted`, 12 px, chips separated by 12 px. Click any chip → popup.
- **`until(ms)`**: floor; past → `now`; < 1 h → `47m`; < 1 d → `3h 54m`;
  else `6d 7h`. Pure, tested (shared copy in the popup mod; mods can't share
  files, so `src/usage/format.js` is the tested source and each mod has a
  copy — a test asserts the copies match the source text).

### Popup mod `mods/orca-usage-panel/` (`mod.json`: `{ "place": "none", "title": "Usage" }`)

Opened by a chip: `openOverlay({ mod: "orca-usage-panel", kind: "popup",
width: 340, height: 360 })`. Draws nothing without `props().overlay`.
- Header "Usage · all agents", "checked {N}m ago", refresh button →
  `setShared("orca.usage.refresh", { at: Date.now(), force: true })` (shows
  `···` while `fetching`).
- Per available provider (sorted by highest used %, as Orca): name + icon;
  per window a row `"{label} · resets in {until}"` (or `resets now`; named
  buckets show just the label), a full-width 5 px bar coloured by used %:
  `< 80` `theme().ansi2`, `≥ 80` `ansi3`, `≥ 90` `ansi1`; and `{pct}%`.
  Error → its text in `t.blocked` under the name.
- Unavailable providers listed dim at the bottom with their reason
  ("Not installed", "Not signed in", "Update agy to show usage").

### Install

`scripts/install.sh` default list adds `orca-usage orca-usage-panel` (both
get `config.js`).

## Testing

- `node --test` with fixtures (no network, no keychain): Claude mapping
  (`five_hour`/`seven_day`, `utilization` vs `used_percentage`, ISO / s / ms
  `resets_at`, each Fable variant, missing windows); Claude status mapping for
  401, 429, 500, keychain missing vs denied (inject the fetch and the
  `security` runner); Codex mapping (300/10080, unknown durations, nulls) and
  the RPC sequence against a fake `codex` script on `PATH` (replies, error,
  silence → timeout); agy parsing (SUCCESS with one- and multi-bucket groups,
  `disabled`, ERROR, prompt-style output with no JSON, version gate 1.1.10 vs
  1.1.11); `until()` boundaries (59 s, 60 s, 3 599 s, 3 600 s, 1 d); headline
  choice; the mod copies of `format.js` match.
- `herdr-app check` on both mods.
- Manual: macOS keychain prompt → Always Allow; chips show Claude, Codex,
  Antigravity with sensible numbers matching `claude /usage`-style output and
  agy's own status line (96% / 83% in an earlier screenshot); click → panel
  with every window and colours; refresh → `···` then new time; quit Codex
  login (or rename `codex` on PATH) → its chip disappears; network off →
  `⚠` with old numbers.

## Review notes

Builder check (2026-11-17): three points settled by following Orca, since the
person asked to mimic it — agy stop/sign-out rules (Orca's two separate
signals), Claude's extra token locations (config-dir keychain item and
`~/.credentials.json`), and `ok` without windows shown as `--`. Codex
timeouts raised to Orca's 30 s + 10 s.

## Left to the builder

- Exact chip spacing and bar radius within theme colours.
- How the fake `codex` / `agy` scripts are put on `PATH` in tests.
