# Resource manager sampling performance

## Goal

Reduce the CPU and subprocess work performed by the Resource Manager while its popup is closed. Keep the status chip useful, keep the open popup responsive, and preserve CPU and RSS accounting, terminal grouping, and PTY actions. The changes use the installed Herdr mod APIs and the existing installer.

This spec extends the [Resource Manager design](2026-11-17-resource-manager-design.md). The source paths below are in `herdr-orca-worktrees`. The benchmark machine currently runs the sibling `orca-rs` checkout through the `orca-rs` layout. Its `scripts/install-orca-rs.sh` generates `orca-resources-rs` and the `orcars.resources*` shared keys from that checkout's `mods/orca-resources` and `mods/orca-resources-panel`. Apply the same behavior in the sibling source before claiming an improvement for that layout.

## Baseline

`mods/orca-resources/main.js` runs two `ps` commands and `hc ls --json` in parallel per sample. The target interval is two seconds with the popup open and five seconds otherwise. Terminal metadata and repo grouping are cached per sampler instance. A cold cache can add `hc get` per local terminal and `orca-wt info` per distinct place.

On the benchmark Mac, `hc ls` omitted PID and labels for all 18 live local terminals. `hc get` returned both fields for all 18. The combined `ps` output matched the separate command and parent fields for 621 PIDs present in all captures.

| Command-path benchmark | Current | Combined `ps` |
|---|---:|---:|
| Warm subprocess CPU per sample, mean of 40 runs | 42.1 ms | 28.5 ms |
| Warm elapsed time, median of 40 runs | 39.1 ms | 37.5 ms |
| Cold elapsed time with 18 `hc get` calls, median of 16 runs | 72.5 ms | 67.7 ms |

The benchmark invoked the commands outside Herdr. Its cold run excluded repo lookups and rendering. A 40-second observation of the installed layout recorded zero new snapshots in the persisted shared-state file, so the live cadence, whole-app savings, and popup-open latency still need verification.

## 1. Reduce sampling frequency and combine process scans

Implement this first. The benchmark predicts the largest background savings from the cadence change, and the combined scan reduces the cost of every sample.

| State | Target interval after a sample completes | Warm commands per minute at target cadence |
|---|---:|---:|
| Resource popup open | 2 s | 60 |
| Popup closed, Herdr window active | 15 s | 8 |
| Popup closed, Herdr window inactive | 30 s | 4 |

- Use the popup lifecycle flag and `window().active` from `herdr`. Give the open popup precedence over the main window's focus state because the popup can itself take focus. If focus data is unavailable, use the 15-second closed cadence. Keep the existing lightweight timer to check for transitions unless the host exposes a reliable activity notification.
- Request a fresh sample on startup, on popup open, when Herdr regains focus, and on a new manual refresh signal, including the refresh after ending PTYs. Serve the last good snapshot while collection runs. Launch within one scheduler tick at most when no collection is running. Combine simultaneous triggers and queue at most one follow-up for a request received during collection. Schedule periodic samples from completion so slow commands cannot overlap. Cancel scheduled work and suppress late publication when the sampler is destroyed.
- On the supported macOS path, run `ps -axo pid=,ppid=,pcpu=,rss=,comm=` and `hc ls --json` in parallel. Parse the first four fields and retain the full command remainder, including spaces. Use the same snapshot to identify Herdr processes and walk terminal descendants. Keep the existing separate scans as a compatibility fallback where the combined format is unsupported. Avoid repeating a failed capability probe on every tick.
- Keep the last good snapshot if required collection fails or terminal JSON is unusable. A valid empty list still publishes zero terminal rows. Keep the snapshot contract and its observation timestamp. Preserve the bounded history of actual samples without inserting synthetic points during slow periods. Any fixed-duration chart label must account for the variable cadence.
- Folding a project or worktree should avoid building its hidden detail rows. Keep collecting and showing the aggregate for any visible parent. Keep PTY foreground detail lookups tied to explicit row expansion.

At the proposed cadences, measured command costs imply about **0.19% of one core** with the popup closed and the window active, and **0.10%** when inactive, versus **0.84%** at the original five-second cadence. These are projections for warm sampler subprocesses.

## 2. Reuse metadata and invalidate it on relevant changes

- Index the live `terminals()` records by address once per sample. Prefer current PID and label fields from `hc ls` or Herdr when those fields are present, then reuse metadata from a successful lookup for the same live terminal. Preserve the distinction between known empty labels and missing labels. Fetch missing metadata with `hc get` through a queue capped at four concurrent lookups. Evict cache entries when a terminal disappears from a successful listing. Replace cached values when current data identifies a changed PID or labels. Keep a short retry delay for failures instead of caching missing fields indefinitely.
- Resolve each distinct place once per refresh when repo metadata is due. Evict inactive places and retry lookups that failed when their retry delay expires. Keep `orca-wt info` authoritative for linked worktree grouping. If a place cannot be resolved, continue to show its folder-based grouping.
- Use `watchFolder()` for verified, narrow Orca state or Git worktree metadata directories, such as an existing Git common directory's `worktrees` subfolder. Scope watches to repo roots represented by live terminals. A relevant change dirties only the affected metadata. Coalesce bursts for 250 ms and handle a batch containing the watched root as an invalidation for that root. Reconcile dirty metadata on the next eligible sample so a busy watcher cannot drive extra process scans.
- Rearm each one-shot watch after it resolves. Cancel watches when their roots leave the live set or the sampler is destroyed. When a watch path cannot be identified, a directory goes away, or the host rejects the watch, revalidate the affected metadata on a 60-second cadence while it remains relevant. Keep timed resource sampling for CPU and RSS.

## 3. Decision on a Rust helper

Defer `orca-wt resources` until the first two changes are measured end to end. Consider it if the remaining collection costs materially affect idle CPU or popup-open latency. It would need to replace the `ps` scan with native process collection or eliminate another subprocess, and preserve terminal coverage and grouping. A wrapper that still runs both underlying commands leaves those launches in place.

## Acceptance and verification

1. Extend `test/resources-mod.test.js` with fake time, focus, popup state, and deferred command results. Verify the three cadences, refresh on open and focus return, a queued refresh during an in-flight sample, and teardown. Verify that a scheduled warm sample starts exactly one `ps` and one `hc ls` on the combined path.
2. Extend `test/resources-tree.test.js` and the mod harness to cover command paths with spaces, paired process and command fields, nested terminal roots, local unlabelled terminals, remote exclusion, and the legacy process-scan fallback. Check invalid command output and a valid empty terminal list.
3. Exercise a cold cache, a repeat sample, a disappearing terminal, a changed PID or labels, a failed metadata lookup, and a worktree metadata change. Assert the four-call concurrency limit, that a watch burst coalesces, that watch cancellation releases the handle, and that watch failure leaves periodic reconciliation working.
4. Run `npm test` and validate the sampler and popup with the repository's Herdr mod checks. In a live smoke test, verify that the chip, popup totals, grouping, sparklines, and PTY refresh still work. Confirm that a focused popup keeps its two-second cadence when it takes focus from the main window.
5. Repeat the subprocess A/B against the same terminal set with at least 40 warm and 16 cold samples per version. Record command counts, mean subprocess CPU, and median and p90 elapsed time. Expect lower mean CPU on the warm combined path. Compare cold p90 before and after the concurrency cap, since batching fewer lookups at once can increase elapsed time. Separately run at least three paired 60-second live windows per closed state with the same layout, terminal workload, and focus conditions. Confirm samples by observing live state or temporary sampler instrumentation. Time popup open to first fresh snapshot with warm and cold caches. Report a whole-app improvement only if the live comparison establishes one.

## References

| Source | Responsibility |
|---|---|
| `mods/orca-resources/main.js` | Scheduler, collection, metadata caches, publication |
| `mods/orca-resources/tree.js` | Process parsing, accounting, history |
| `mods/orca-resources-panel/main.js` | Popup lifecycle, manual refresh, folded rows and PTY details |
| `scripts/install.sh` | Install and check the source mods |

If the rollout regresses grouping, refreshes, or CPU use, revert the sampler and panel source changes together and reinstall the previous source through the normal installer. The shared snapshot stays readable across versions.
