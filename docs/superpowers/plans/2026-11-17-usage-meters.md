# Usage Meters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orca-style usage chips for Claude, Codex and Antigravity in the bottom `orca` strip, with a click-open "Usage · all agents" panel.

**Architecture:** `orca-wt usage` (Node, `src/usage/`) fetches all providers in parallel and prints `{ providers }`. Pure mappers and formatters are unit-tested on fixtures; network, keychain and child processes are injected so tests never touch them. A long-lived `orca-usage` strip mod polls (15 min rule), keeps per-session agy flags, and publishes via `setShared`; an `orca-usage-panel` popup reads it and requests refreshes.

**Tech Stack:** Node 24 (`fetch`, `node:child_process`, `node:crypto`), `node:test`, Herdr.app mods (gpui-kit, gpui-base, `herdr`).

**Spec:** `docs/superpowers/specs/2026-11-17-usage-meters-design.md`

## Global Constraints

- Provider / Window shapes exactly as the spec (`id`, `status: "ok"|"unavailable"|"error"`, `error?`, `windows`, `fetchedAt`, `manualOnly?`, `stopAsking?`; window `label`, `minutes`, `usedPercent`, `resetsAt` ms|null).
- Claude: headers `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/2.1.0`; 10 s timeout. The token is never logged, written, returned, or put in an error string.
- Codex args: `-c approval_policy=never -c features.plugins=false -s read-only -a never app-server`; 30 s for `initialize`, 10 s for `account/rateLimits/read`.
- agy: version ≥ **1.1.11**; `agy -p /usage --output-format json --print-timeout 20s`, env `AGY_CLI_DISABLE_AUTO_UPDATE=true`, 30 s; never `--disable-slash-commands`.
- Polling: every 15 min; manual refresh allowed any time with `force: true`, otherwise not within 5 min; stale after 30 min; mod `exec` timeout 60 000 ms.
- Shared keys: `orca.usage.data` (`{ providers, fetchedAt, fetching }`), `orca.usage.refresh` (`{ at, force }`).
- Bar colours by used %: `< 80` `theme().ansi2`, `≥ 80` `ansi3`, `≥ 90` `ansi1`.
- Mods: `init()` returns early on `checking()`; the panel draws nothing without `props().overlay`. Never edit shipped mods or `layouts/main.json`; outside the repo only `~/.config/herdr-app/layouts/orca.json` changes (back it up).
- Commits: no AI co-author trailer.

## Review Focus

1. A Claude error must never echo the token (e.g. a thrown fetch error message containing headers) — test `claude errors never include the token` (Task 2).
2. agy signed out must not be polled again until a manual refresh — test `signed out → manualOnly` (Task 3) + Task 5 Step 3 `--skip agy` + manual check 6.
3. A slow `codex app-server` start (25 s) must still succeed — test `codex slow start within 30 s` (Task 3).
4. `ok` with no windows must render `--`, not `···` forever — test `headline of empty ok` (Task 1).
5. Stale old numbers + error must show `⚠` and keep the numbers — test `merge keeps last ok windows on error` (Task 5 pure helper).

---

## Files

- Create: `src/usage/format.js`, `src/usage/claude.js`, `src/usage/codex.js`, `src/usage/agy.js`, `src/usage/index.js`, `test/usage-format.test.js`, `test/usage-claude.test.js`, `test/usage-codex.test.js`, `test/usage-agy.test.js`, `test/usage-cli.test.js`, `test/fixtures/usage/` (fake `codex` / `agy` scripts, JSON samples)
- Create: `mods/orca-usage/{main.js,mod.json,format.js,merge.js}`, `mods/orca-usage-panel/{main.js,mod.json,format.js}`
- Modify: `bin/orca-wt.js` (async `usage` command), `scripts/install.sh:16`
- Modify (outside repo, Task 6): `~/.config/herdr-app/layouts/orca.json`

### Task 1: Formatting (`src/usage/format.js`)

**Interfaces — Produces (`module.exports`; ESM copies in the mods, see Task 5):**
- `until(resetsAt: number|null, now: number) => string` — `""` for null; `≤ now` → `"now"`; `< 1 h` → `"Nm"`; `< 1 d` → `"Nh Mm"`; else `"Nd Nh"` (floor).
- `headline(p: Provider, now) => string` — `···` when no `fetchedAt` and no windows yet (status missing); `ok` with `[]` → `"--"`; else max-`usedPercent` window: `minutes > 0` → `` `${pct}% ${until(resetsAt, now) || label}` ``; `minutes === 0` → `` `${label} ${pct}%` ``.
- `barColor(pct) => "ansi2" | "ansi3" | "ansi1"`.

- [ ] **Step 1: Tests** (`test/usage-format.test.js`): `until(now + x, now)`: `x=59_000`→`"0m"`, `+60_000`→`"1m"`, `+3_599_000`→`"59m"`, `+3_600_000`→`"1h 0m"`, `+86_400_000`→`"1d 0h"`, `now-1`→`"now"`, `null`→`""`. `headline`: windows 5h 42% (resets +3h12m) & Weekly 18% → `"42% 3h 12m"`; named bucket `{label:"Flash",minutes:0,usedPercent:30}` highest → `"Flash 30%"`; window with `resetsAt:null` → `"42% 5h"`; **`headline of empty ok`** `{status:"ok",windows:[]}` → `"--"`; `{}` → `"···"`. `barColor(79)`→ansi2, `80`→ansi3, `90`→ansi1.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npm test` → pass.
- [ ] **Step 5:** `git add src/usage/format.js test/usage-format.test.js && git commit -m "feat: usage formatting"`

### Task 2: Claude (`src/usage/claude.js`)

**Interfaces — Produces:**
- `keychainCandidates(env) => string[]` — service names in lookup order (config-dir item `Claude Code-credentials-<sha256(dir).hex.slice(0,8)>` first when `CLAUDE_CONFIG_DIR` set, then `Claude Code-credentials`).
- `keychainAccount(user) => string` — `user` if `/^[a-zA-Z0-9._-]+$/`, else `"claude-code-user"`.
- `mapClaudeUsage(json) => Window[]`
- `fetchClaude({ readSecret, readFile, fetchImpl, env, now }) => Promise<Provider>` — `readSecret(service, account) => { ok: true, value } | { ok: false, missing: boolean }`; defaults run `security find-generic-password -s <service> -a <account> -w` (exit 44 = missing) and read `~/.claude/.credentials.json`.

- [ ] **Step 1: Tests** (`test/usage-claude.test.js`), all with injected fakes:
  - `keychainCandidates` with/without `CLAUDE_CONFIG_DIR=/x` (assert the hash suffix equals `crypto.createHash("sha256").update("/x").digest("hex").slice(0,8)`); `keychainAccount("jimmy_nguyen")`, `keychainAccount("a b")`.
  - `mapClaudeUsage`: `{five_hour:{utilization:42,resets_at:"2026-11-17T12:00:00Z"},seven_day:{used_percentage:18,resets_at:1800000000}}` → `5h` 42 with ISO ms, `Weekly` 18 with `1800000000*1000`; `resets_at: 1800000000000` → ms kept; each Fable form (`limits[{kind:"weekly_scoped",scope:{model:{display_name:"Fable"}},percent:12}]`, `fable_weekly`, `fable_seven_day`, `seven_day_fable`) → `Fable` 12; missing windows skipped.
  - status: all secrets missing and no file → `unavailable` "Not signed in"; denied (`missing:false`) → `error` "Allow keychain access for Claude usage"; file fallback used when keychain missing; 401 → `error` "Updates the next time Claude runs"; 429 → "Rate limited"; 500 → error mentions 500; fetch throws → error.
  - request: the fake `fetchImpl` receives the exact URL and three headers.
  - **`claude errors never include the token`**: token `"sk-ant-SECRET"`; for 401, 500 and a thrown error whose message contains the token, `JSON.stringify(result)` doesn't contain `SECRET`.
- [ ] **Step 2–4:** run → FAIL; implement; `npm test` → pass.
- [ ] **Step 5:** `git add src/usage/claude.js test/usage-claude.test.js && git commit -m "feat: claude usage"`

### Task 3: Codex and agy (`src/usage/codex.js`, `src/usage/agy.js`)

**Interfaces — Produces:**
- `mapCodexLimits(result) => Window[]`; `fetchCodex({ command = "codex", env, timeouts = { init: 30000, read: 10000 }, now }) => Promise<Provider>`.
- `parseAgyUsage(stdout, stderr) => { windows } | { stopAsking: true } | { signedOut: true } | { error }`; `versionAtLeast(v, "1.1.11") => boolean`; `fetchAgy({ command = "agy", env, now }) => Promise<Provider>`.

- [ ] **Step 1: Fixtures.** `test/fixtures/usage/fake-codex.js` (node script, `#!/usr/bin/env node`, chmod +x in the test): reads NDJSON on stdin; behaviour from env `FAKE_CODEX_MODE` = `ok` (replies to id 1, then to id 2 with `{rateLimits:{primary:{usedPercent:42,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:18,windowDurationMins:10080,resetsAt:1800500000}}}`), `slow` (waits `FAKE_CODEX_DELAY` ms before the id-1 reply), `error` (id-2 JSON-RPC error `{code:-1,message:"not logged in"}`), `silent` (never replies). `fake-agy.js` prints `--version` → `FAKE_AGY_VERSION`, and for `-p /usage` prints the file named by `FAKE_AGY_OUT` (stdout) / `FAKE_AGY_ERR` (stderr). JSON samples for agy: success one-bucket group, multi-bucket group with one `disabled`, `ERROR`, model-turn (`{"num_turns":1}`), signed-out text (`Error: not logged in`).
- [ ] **Step 2: Tests** (`test/usage-codex.test.js`, `test/usage-agy.test.js`):
  - `mapCodexLimits`: 300/10080 → `5h`/`Weekly`, `resetsAt` ×1000; durations 299 and 10081 still map (±1); unknown durations → primary `5h`, secondary `Weekly`; null windows skipped.
  - codex `ok` → `status:"ok"` 2 windows; **`codex slow start within 30 s`**: `slow` with delay 300 ms and `timeouts.init: 1000` → ok; `silent` with `timeouts {init:300}` → `error` "Codex did not answer" and the child is killed (no leftover process: check `child.killed`/exit); `error` → `unavailable` "Not signed in"; missing command (`command: "/no/such/codex"`) → `unavailable` "Not installed".
  - agy: `versionAtLeast` for `1.1.10`→false, `1.1.11`→true, `1.5.9`→true, `agy 1.5.9`-style prefix handled; one-bucket → label = group name, `usedPercent = round((1-0.62)*100) = 38`, `weekly`→10080; multi-bucket → `"Gemini · Flash"` labels, disabled dropped; `ERROR` → error text; model-turn → `stopAsking`; **`signed out → manualOnly`**: `fetchAgy` → `status:"unavailable"`, `manualOnly:true`, error "Sign in with agy"; version 1.1.10 → `unavailable` "Update agy to show usage" without running `/usage` (fake writes a marker file if `/usage` is called — assert absent); garbage stdout → `error` "Couldn't read agy usage".
- [ ] **Step 3–5:** run → FAIL; implement (Codex: `spawn` with stdio pipes, line-split stdout, `setTimeout` per phase, `kill()` in `finally`); `npm test` → pass.
- [ ] **Step 6:** `git add src/usage/codex.js src/usage/agy.js test/usage-codex.test.js test/usage-agy.test.js test/fixtures/usage && git commit -m "feat: codex and agy usage"`

### Task 4: `orca-wt usage` CLI

**Interfaces — Produces:** `src/usage/index.js` `fetchAll({ only?: string, skip: string[], deps? }) => Promise<{ providers: Provider[] }>` (order claude, codex, agy; `Promise.all`; any provider promise that throws becomes `{ id, status: "error", error: "Couldn't read usage", windows: [], fetchedAt }`). `bin/orca-wt.js`: `usage [--only <id>] [--skip <id>]...` — this command is async; restructure `main` so `usage` awaits and every other command keeps its exact current output.

- [ ] **Step 1: Tests** (`test/usage-cli.test.js`): `fetchAll` with stub deps → three providers in order; `skip: ["agy"]` → two; `only: "codex"` → one; a throwing stub → that provider `error`, others fine. CLI: `spawnSync(node, ["bin/orca-wt.js","usage","--only","codex"], { env: { ...process.env, PATH: <fixtures dir>:..., FAKE_CODEX_MODE: "ok" } })` → stdout JSON with one ok codex provider (put `fake-codex.js` on PATH as `codex` via a temp dir symlink). `npm test` keeps all existing CLI tests green.
- [ ] **Step 2–4:** FAIL → implement → pass.
- [ ] **Step 5:** `git add src/usage/index.js bin/orca-wt.js test/usage-cli.test.js && git commit -m "feat: orca-wt usage command"`

### Task 5: Mods

**Interfaces — Consumes:** Task 4 CLI; Task 1 functions (ESM copies). **Produces:** `mods/orca-usage/merge.js` `merge(prev: Provider[], next: Provider[], skipped: string[]) => Provider[]` (pure).

- [ ] **Step 1: Copies + merge tests.** Create `mods/orca-usage/format.js` and `mods/orca-usage-panel/format.js` as ESM copies of `src/usage/format.js` (`export function …`). Test (`test/usage-mods.test.js`): import both copies (`await import(...)`; `mods/package.json` already says module) and assert they give the same results as the CJS source on the Task 1 cases. `merge` tests: **`merge keeps last ok windows on error`** (prev ok 42%, next error → windows kept, `status:"error"`, `error` set); `unavailable` clears windows; skipped ids keep their prev entry unchanged; new providers added.
- [ ] **Step 2:** run → FAIL; implement `merge.js`; pass.
- [ ] **Step 3: `orca-usage` strip.** `mod.json` `{ "place": "none", "title": "Usage" }`. State: `providers = []`, `fetchedAt = 0`, `fetching = false`, `stopAsking = false`, `manualOnly = false`, `lastRefresh = shared("orca.usage.refresh")?.at ?? null`, `icons = {}`. `init`: `knownAgents()` → map `run[0]` (`claude`/`codex`/`agy`) to `{icon,tint}`; `fetch(cx)`; `cx.timer.every(60000, …)` → fetch if `Date.now() - fetchedAt >= 15*60000`; same timer and `render` path also check `shared("orca.usage.refresh")`: new `at` → if `force`, clear `manualOnly` and fetch; else fetch only if ≥ 5 min since `fetchedAt`. `fetch(cx)`: skip if `fetching`; set `fetching`, publish; `args = ["usage", ...(stopAsking||manualOnly ? ["--skip","agy"] : [])]`; `exec(config.node, [config.cli, ...args], { timeout: 60000 })` → parse → set `stopAsking`/`manualOnly` from the agy entry → `providers = merge(providers, r.providers, skipped)`; on throw mark every provider `error` keeping windows; `fetchedAt = Date.now()`, `fetching = false`, `setShared("orca.usage.data", { providers, fetchedAt, fetching })`, `cx.notify()` after the await. Render: right-aligned `h_flex` of chips for providers not `unavailable` (order claude, codex, agy): icon (13 px; `svg` when `tint`, else `image`; fallback name), `headline()` text (`muted`, `dim` when stale > 30 min), `⚠` in `t.blocked` when `error`; gap 12; whole row clickable → `openOverlay({ mod: "orca-usage-panel", kind: "popup", width: 340, height: 360 })`. Drop lowest-used chips when `on_size_change` width can't fit (≈ 110 px per chip).
- [ ] **Step 4: `orca-usage-panel`.** `mod.json` `{ "place": "none", "title": "Usage" }`. Reads `shared("orca.usage.data")`. Header "Usage · all agents", "checked {until-style ago}" (`Nm ago`), refresh button (`setShared("orca.usage.refresh", { at: Date.now(), force: true })`; shows `···` while `fetching`). Available providers sorted by highest used %: name, then each window row `"{label} · resets in {until}"` (`resets now`; named buckets: label only), 5 px bar in `theme()[barColor(pct)]` on `t.border` track, `{pct}%`; `error` text in `t.blocked`; `ok` with no windows → "No limits reported". Unavailable providers last, dim, with their `error` reason.
- [ ] **Step 5: Install + check.** `scripts/install.sh:16` → add `orca-usage orca-usage-panel`. `bash scripts/install.sh orca-usage orca-usage-panel && herdr-app check ~/.config/herdr-app/mods/orca-usage && herdr-app check ~/.config/herdr-app/mods/orca-usage-panel && npm test` → pass.
- [ ] **Step 6:** `git add mods/orca-usage mods/orca-usage-panel scripts/install.sh test/usage-mods.test.js && git commit -m "feat: usage chips and panel"`

### Task 6: Layout and verification

- [ ] **Step 1: Layout.** `cp ~/.config/herdr-app/layouts/orca.json ~/.config/herdr-app/layouts/orca.json.bak-usage`. Replace the bottom block (`content.mod: "orca-setup"`, `size.px: 28`, child of the outer column) with `{ "id": "orca-strip", "type": "row", "size": { "px": 28 }, "children": [ <that block with size {"weight": 1}>, { "id": "orca-usage", "type": "block", "size": { "px": 420 }, "content": { "mod": "orca-usage" } } ] }`. `herdr-app status` → `"errors": []`.
- [ ] **Step 2: Manual checks** (each observed; stop and ask the person):
  1. First load: macOS asks to let `security` read "Claude Code-credentials" → Always Allow; chips appear for Claude, Codex, Antigravity within ~45 s (`···` first).
  2. Numbers are plausible: agy's chip agrees with agy's own status line (its `Usage` bars); Claude's 5h roughly matches Claude's own usage screen.
  3. Click a chip → panel lists every window with resets and coloured bars; refresh → `···` then "checked 0m ago".
  4. The Setup strip's Remove button still works for a worktree space.
  5. Wi-Fi off, press refresh → `⚠` beside the old numbers; Wi-Fi on, refresh → `⚠` gone.
  6. (If convenient) `agy logout`, refresh → Antigravity listed dim "Sign in with agy" in the panel and no browser opens on later 15-min ticks; `agy login`, refresh → back.
  7. `ctrl-shift-l` to `main` → unchanged, no usage strip there.
