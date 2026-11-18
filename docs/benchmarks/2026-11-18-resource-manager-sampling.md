# Resource Manager sampling benchmark

Measured 2026-11-18 on macOS against 18 live local terminals. The installed `orca-rs` sampler and the JavaScript source use the same three-command baseline. This benchmark ran subprocesses outside the Herdr mod runtime.

## Method

- Warm runs execute the process scan and `hc ls --json` concurrently. The baseline uses two `ps` processes. The candidate uses one `ps -axo pid=,ppid=,pcpu=,rss=,comm=` process.
- Cold runs additionally fetch metadata by running `hc get <address> --json` for every missing terminal record. All 18 entries needed metadata for the measured inventory. The baseline starts every lookup in parallel. The candidate caps concurrency at four. An uncapped candidate isolates the effect of that limit.
- Each comparison interleaves variants in a seeded, shuffled order and excludes the first two warm-up repetitions. Elapsed time includes launching and collecting output from the commands. Subprocess CPU is the change in cumulative child user plus system CPU time.

| Path | Runs | Launches per sample | Mean child CPU | Median elapsed | p90 elapsed |
|---|---:|---:|---:|---:|---:|
| Baseline, warm | 40 | 3 | 44.1 ms | 42.3 ms | 111.0 ms |
| Combined, warm | 40 | 2 | 28.2 ms | 38.3 ms | 118.8 ms |
| Baseline, cold | 16 | 21 | 118.4 ms | 129.1 ms | 164.3 ms |
| Combined, cold, uncapped | 16 | 20 | 99.0 ms | 75.7 ms | 144.5 ms |
| Combined, cold, four concurrent | 16 | 20 | 99.9 ms | 74.1 ms | 133.0 ms |

Warm subprocess CPU fell by **36%** in this run. A second 40-pair run measured a **29%** reduction. The elapsed-time tail varied across runs. The four-call cap slightly lowered cold p90 in the three-way comparison, while a separate run under heavier load showed higher cold p90 for the capped candidate than for the baseline. Treat cold elapsed time as workload-sensitive.

## Cadence projection

This calculation uses mean warm subprocess CPU and the nominal refresh intervals. A demand-triggered refresh or cache miss adds work.

| Popup closed | Original at 5 s | Proposed | Estimated sampler CPU reduction |
|---|---:|---:|---:|
| Herdr window active | 0.88% of one core | 0.19% at 15 s | 79% |
| Herdr window inactive | 0.88% of one core | 0.09% at 30 s | 89% |

## Staged verification

| Check | JavaScript layout | Rust layout |
|---|---:|---:|
| JavaScript tests passed | 344 of 344 | 344 of 344 |
| Rust tests passed | | 44 of 44 |
| Individual installed resource mod checks passed | 2 of 2 | 2 of 2 |

The Rust release build succeeded. Both installs used temporary Herdr app homes. The two layouts reference their respective resource chips. All 14 staged resource files match after accounting for installer-generated configuration, manifest changes, and namespace rewrites. The Rust chip and panel use the `orcars.resources`, `orcars.resources.open`, and `orcars.resources.refresh` shared keys.

## Live measurement status

The command benchmark excludes repo lookups, JavaScript aggregation, rendering and shared-state updates. The prior live observation recorded no new persisted resource snapshot in 40 seconds. Live whole-app CPU, confirmed sampling cadence, and time from popup open to first fresh snapshot are pending a controlled before/after run on an installed build.

Live rollout was outside the authorized scope, and these builds were exercised only in temporary installs. The live layout smoke test, paired 60-second whole-app CPU windows, and warm and cold popup timing remain pending.
