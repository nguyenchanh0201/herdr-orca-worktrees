# Resource Manager Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Resource Manager subprocess CPU and refresh work while keeping the popup responsive and the resource totals accurate.

**Architecture:** The chip remains the single publisher of the shared resource snapshot. It schedules samples according to popup visibility and window focus, collects process data in one scan, and refreshes cached metadata only when needed. The popup continues rendering that snapshot and requesting explicit refreshes.

**Tech Stack:** JavaScript Herdr mods, `ps`, `hc`, Node's test runner, and the existing Node and Rust `orca-wt info` implementations.

**Spec:** [Resource manager sampling performance](../specs/2026-11-18-resource-manager-performance-design.md)

## Global Constraints

- Sample **2 s** after completion with the popup open, **15 s** with it closed and the window active, and **30 s** with it closed and the window inactive. Missing focus data uses **15 s**. Popup open takes precedence.
- Cap concurrent terminal metadata lookups at **four**. Coalesce watch bursts for **250 ms**. Revalidate unwatchable metadata every **60 s** while relevant.
- Preserve shared snapshot keys, timestamps, grouping, RSS units, CPU semantics and PTY actions. Retain the bounded history of real samples and the last good snapshot on collection failure.
- Use the installed Herdr APIs. Defer the Rust resource collector until the live benchmark establishes a need. Keep installer-generated files out of source edits.
- Use separate commits per completed unit if executing with commits enabled. Keep unrelated changes out of staging, including existing declaration files and the sibling checkout's untracked installer.

## Review Focus

1. A combined process scan succeeds at launch and later returns unusable data. Collection retries on the combined path after a transient failure and retains the last good snapshot meanwhile. Task 1.
2. Focus returns at the same time a manual refresh arrives during collection. Exactly one follow-up runs. Task 2.
3. A terminal address returns after eviction or reports a different PID. The sampler drops stale labels from the old terminal. Task 3.
4. A watch resolves after its repo is removed or the view is destroyed. The callback neither rearms nor dirties the replacement cache. Task 4.
5. A folded project or worktree contains many terminals. Its aggregate stays visible and the renderer skips sorting the hidden child rows. Task 5.

## File Map

| Path | Responsibility |
|---|---|
| `mods/orca-resources/tree.js` | Combined process parsing and existing accounting helpers |
| `mods/orca-resources/main.js` | Collection validation, scheduling, caches and watch lifecycle |
| `mods/orca-resources-panel/main.js` | Folded rendering and sample history presentation |
| `src/git-info.js`, `src/commands.js` | Expose the canonical Git common directory already resolved during `info` |
| `test/resources-tree.test.js`, `test/resources-mod.test.js`, `test/git-info.test.js`, `test/cli.test.js` | Process, scheduler, cache, watch and CLI regressions |
| Sibling `orca-rs/rust/src/git_info.rs`, `rust/src/commands.rs` | Additive `info` parity for the active layout |
| `docs/benchmarks/2026-11-18-resource-manager-sampling.md` | Before/after results and live verification |

### Task 1 — Collect processes in one scan

**Files:** `mods/orca-resources/tree.js`, `mods/orca-resources/main.js`, `test/resources-tree.test.js`, `test/resources-mod.test.js`.

**Interfaces:** Add `parseProcessSnapshot(text): { procs: Map, commands: Map } | null` in `tree.js`. Keep the existing `parsePs(text)`, `subtreeTotals`, and `herdrTotals` contracts. Add `collectProcesses(): Promise<{ procs: Map, commands: Map }>` to the chip.

- [ ] Add parser fixtures asserting `commands.get(5) === "/Applications/Herdr Core.app/Contents/MacOS/herdr-core"`, matching PID/PPID/CPU/RSS, skipped malformed lines, and `null` for wholly unusable output. Keep existing nested-terminal and Herdr deduplication assertions.
- [ ] Update chip fixtures for the combined command. Assert a warm command set of `ps -axo pid=,ppid=,pcpu=,rss=,comm=` and `hc ls --json`. Add cases for an unsupported combined format, a transient failure after successful collection, an invalid `hc ls` response, an empty terminal list, and remote/unlabelled terminal handling. Assert the fallback probe occurs once for an unsupported format and the previous snapshot survives transient failures.
- [ ] Run `node --test test/resources-tree.test.js test/resources-mod.test.js`. Expect the new assertions to fail against the old command path.
- [ ] Implement the parser and collector. Split the first four columns from the full command remainder. Run the collector in parallel with `hc ls`. Remember legacy mode for the view after an explicit unsupported-format error, or after an unusable initial combined response only if a subsequent legacy capture succeeds. Required command failures and a missing `terminals` array abort publication. A valid empty array still publishes a fresh snapshot.
- [ ] Rerun both resource test files. Commit this unit separately if using commits.

### Task 2 — Schedule by popup and window state

**Files:** `mods/orca-resources/main.js`, `test/resources-mod.test.js`.

**Interfaces:** Keep `tick(cx)` and `sample(cx)`. Add `requestSample(cx)` for startup and explicit triggers, and `destroy()` for lifetime cleanup. The existing `orca.resources.open` and `orca.resources.refresh` values remain the cross-mod interface.

- [ ] Give the chip harness a fake clock, a `window()` stub, cancellable timer records, and deferred exec responses. Assert zero scheduled samples before the 2,000/15,000/30,000 ms completion-based deadlines and one sample at the applicable deadline. Simulate missing focus data and a popup that takes focus from the main window.
- [ ] Replace the existing overlap test with a deferred-collection test. During one in-flight sample, signal refresh and focus return together. Assert one current collection and exactly one follow-up. Also cover opening the popup, manual and post-kill refresh signals, and destruction with a deferred exec. Assert the timer is canceled and the late exec publishes nothing.
- [ ] Run `node --test test/resources-mod.test.js`. Expect the timing, follow-up and teardown assertions to fail.
- [ ] Implement the scheduling state. Read popup visibility, window activity and the refresh token on the existing 1,000 ms tick. Track edges and acknowledge the refresh token only when recorded as pending. Coalesce triggers in one tick, allow a single pending explicit follow-up, and use the existing in-flight guard for periodic work. Keep initial sampling immediate. Let the tick consume refresh requests so render remains read-only. Measure the next periodic deadline from completion.
- [ ] Rerun the resource mod tests. Verify checking mode starts no timers or execs. Commit this unit separately if using commits.

### Task 3 — Reuse terminal and repo metadata

**Files:** `mods/orca-resources/main.js`, `test/resources-mod.test.js`.

**Interfaces:** `resolveTerminalMeta(entry, herdrByAddress, now)` returns a promise of `{ pid, spaceId, tabId }`. Cache raw PID and labels separately from retry timing so a known empty label object remains distinguishable from missing data. `resolveRepo(place, now)` returns a promise of `{ key, name }` and records freshness for Task 4.

- [ ] Add tests for current host data bypassing `hc get`, cached reuse, known empty labels, eviction on successful listing, address reuse with a different PID, changed labels, and bounded retry on failure. With at least six deferred misses, assert a maximum of four simultaneous `hc get` calls and stable terminal order. For repo metadata, assert one `info` per distinct active place, cached reuse, and folder grouping on failure.
- [ ] Run `node --test test/resources-mod.test.js`. Expect the new eviction, concurrency and retry assertions to fail.
- [ ] Index `terminals()` by address once per sample. Merge list and host fields before consulting cached values. If a fresh PID differs, discard cached metadata associated with the earlier PID. Resolve remaining misses through at most four workers and retain the original entry order. Retry failed or incomplete terminal and repo lookups after **5 s** on the next eligible sample. Prune absent terminals and places only after obtaining a valid listing. Keep previous good repo grouping on transient refresh errors and use folder grouping when no good result exists.
- [ ] Rerun the resource mod tests. Commit this unit separately if using commits.

### Task 4 — Invalidate repo metadata with narrow watches

**Files:** `src/git-info.js`, `src/commands.js`, `mods/orca-resources/main.js`, `test/git-info.test.js`, `test/cli.test.js`, `test/resources-mod.test.js`.

**Interfaces:** Add the optional absolute JSON field `gitCommonDir` to successful `orca-wt info` results. The sampler accepts older results without it. Add `syncRepoWatches(cx, activePlaces, now)` and `cancelRepoWatches()` in the chip. A watch record owns its current cancellable promise, the live places it covers and its debounce deadline.

- [ ] Add a linked-worktree fixture asserting that primary and linked paths report the same canonical `gitCommonDir` and keep their existing `worktree`, `primary`, and `linked` values. Add watch stubs for shared repo roots, bursts, a root sentinel, rejected or absent directories, and late completion after cancellation. Assert one watch per root, no sample launched by a watch callback, targeted revalidation on the next eligible sample, and retry of unwatched repo metadata after 60 s. Assert older CLI output uses timed reconciliation.
- [ ] Run `node --test test/git-info.test.js test/cli.test.js test/resources-mod.test.js`. Expect the new CLI field and watch assertions to fail.
- [ ] Return the common directory already resolved by `gitInfo()` through `info`, with no additional Git process. Use `<gitCommonDir>/worktrees` for active repo roots. Rearm successful one-shot watches promptly. Coalesce relevant paths for 250 ms and dirty only places attached to that root. Treat the root sentinel as a full invalidation for that root. Use the 60-second fallback for unwatchable roots and retry a failed watch on that cadence. Treat an empty canceled batch as completion. Guard callbacks with watch identity and sampler lifetime so a late batch cannot rearm an obsolete handle.
- [ ] Rerun the three test files. Commit this unit separately if using commits.

### Task 5 — Skip folded detail work and verify both layouts

**Files:** `mods/orca-resources-panel/main.js`, `test/resources-mod.test.js`, sibling `orca-rs` files from the file map, and the benchmark results file.

**Interfaces:** Keep the existing shared snapshot keys and the `renderSparkline(t, points)` contract. Keep the existing popup use of manual refresh and PTY controls.

- [ ] Add panel cases asserting a folded project skips worktree sorting and a folded worktree skips terminal sorting while both headers retain aggregate CPU and RSS. Assert expanding either still respects sort order. Preserve the PTY detail-on-expansion and post-kill refresh checks.
- [ ] Run `node --test test/resources-mod.test.js`. Expect the hidden sort assertions to fail.
- [ ] Move the sorting work into the expanded rendering branches. Present history as recent samples wherever the duration is stated. Keep the sparkline point arrays and existing bounded retention.
- [ ] Run `npm test`, then `herdr-app check mods/orca-resources` and `herdr-app check mods/orca-resources-panel`. Expect passing tests and both mod checks to exit zero. Commit the panel unit separately if using commits.
- [ ] Port the source changes into the sibling `orca-rs` checkout, preserving its existing differences. Add the same `gitCommonDir` JSON field from its existing Git lookup and the equivalent Rust fixture. Run `npm test`, `cargo test --manifest-path rust/Cargo.toml`, and `cargo build --release --manifest-path rust/Cargo.toml` from the sibling root. Stage the installer output in a temporary `HERDR_APP_HOME` with a `layouts` directory using `bash scripts/install-orca-rs.sh "$PWD"`. Check both generated resource mods individually with `herdr-app check`; the installer logs check failures without necessarily exiting nonzero. Verify the `-rs` names and `orcars.resources*` keys.
- [ ] Before updating the active layout, preserve its current config and capture the live baseline using the protocol below. With authorization for the live rollout, install through the existing flow. Verify chip totals, project grouping, sparklines, popup focus, Refresh, and PTY refresh in the active layout. Use a disposable PTY for the end-action smoke test. Confirm samples via live state or temporary instrumentation before timing. If the app does not publish a fresh sample, record the verification blocker.
- [ ] Record the before/after comparison in `docs/benchmarks/2026-11-18-resource-manager-sampling.md`. Use the same terminal set with at least 40 warm and 16 cold runs per version. Record launches, mean subprocess CPU, and wall-time median and p90. Compare cold p90 around the four-call cap. Run at least three paired 60-second live windows per closed state under equivalent focus and workload. Measure cumulative CPU time for Herdr and its associated core processes over each window. Time popup open to first fresh snapshot under warm and cold caches. Keep subprocess results, live app results and cadence projections identifiable. If grouping, refresh, or measured performance regresses, roll back the sampler and popup together and reinstall the previous source and compatible CLI build.
