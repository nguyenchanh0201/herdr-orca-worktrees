# Orca vs Herdr: RAM and CPU

Measured on 2026-11-18 on a MacBook with 8 cores and 16 GB of RAM, running macOS 26.6. The versions were Herdr.app 0.1.16 with this repo's mods, and the Orca.app installed in `/Applications`. The script is [`measure.js`](measure.js).

## Short answer

- **Orca's own processes use about 2.75× the memory of Herdr's:** about **920 MB** against **333 MB**, with both apps open and idle.
- **CPU at idle is about the same,** around 5–6% of one core each.
- **An agent costs the same in either app,** because it's the same `claude` program: about 320–360 MB per Claude session.
- **The app is a small share of the total.** The agents inside the terminals dominate: about 3.5–3.9 GB per app here.

## What was measured

- **App:** each app's own processes, not the programs running inside its terminals.
  - **Herdr:** `Herdr.app` (the window) and `herdr-core`, the terminal service.
  - **Orca:** the `Orca.app` Electron processes (main, renderer, GPU and helpers) and its `orca-terminal-host` services.
- **Inside:** every terminal's shell and everything under it, such as agents, dev servers and `esbuild`. This is reported separately, because it depends on what you run, not on the app.
- **Memory:** macOS `phys_footprint` from `footprint`, the same number Activity Monitor shows as "Memory". RSS from `ps` is listed too, but it badly undercounts GPU-drawn apps; Herdr's RSS is 81 MB against a real 333 MB.
- **CPU:** the change in each process's cumulative CPU time over a 30-second window, as a percentage of one core. Sampling CPU% once a second is noisier.
- **Same setup in both apps:**
  - One fresh `claude` was started in the same worktree, this repo. In Herdr that was `herdr-app do space.new`, and in Orca `orca terminal create --worktree path:… --command claude`.
  - Both terminals were opened in the background.
  - Both were left idle at the prompt.
  - Both were closed afterwards.

## Results

All memory numbers are `phys_footprint`, in MB. CPU is the percentage of one core over 30 seconds.

| Run | App | Own processes | App memory | App RSS | App CPU | Terminals | Inside memory |
|---|---|---|---|---|---|---|---|
| Orca closed | Herdr | 5 | 336 | 83 | 9.6%¹ | 13 | 3,046 |
|  | Orca (services only) | 3 | **139** | 27 | 0.2% | **17** | **3,511** |
| Both open, idle | Herdr | 5 | 333 | 84 | 9.9%¹ | 13 | 3,050 |
|  | Orca | 11 | 938 | 706 | 5.8% | 17 | 3,510 |
| + 1 Claude in each | Herdr | 5 | 332 | 80 | 7.3% | 14 | 3,457 |
|  | Orca | 10 | 1,003 | 636 | 9.9% | 18 | 3,880 |
| Same, quiet (this session idle) | Herdr | 5 | **333** | 81 | **5.4%** | 14 | 3,451 |
|  | Orca | 10 | **917** | 668 | **6.0%** | 18 | 3,880 |

¹ Herdr was also drawing this Claude Code session while it worked, which costs CPU. The "quiet" run was taken with that session idle.

**The fresh Claude session itself,** process plus children:

| | Herdr | Orca |
|---|---|---|
| Command | `claude` | `claude --plugin-dir …/orca-agent-view --dangerously-skip-permissions` |
| Memory | 318 MB | 360 MB |

Orca injects its own Claude plugin, `orca-agent-view`, which may explain the extra ~40 MB. One sample each, so treat that difference as rough.

## What it means

1. **Herdr's window costs about 600 MB less than Orca's.** Orca is an Electron app: a Chromium renderer, a GPU process and helpers. Herdr is one native GPUI process plus a small Rust terminal service. Most of Herdr's 333 MB is GPU and window memory, which is why its RSS looks so small.
2. **Adding a terminal costs the app almost nothing in either one** (Herdr 333 → 332, Orca 938 → 1,003 → 917, which is noise). What a terminal costs is what runs inside it.
3. **Orca kept terminals running after it was closed.** Before Orca was opened, its two `orca-terminal-host` services still held **17 terminals, 68 processes and about 3.5 GB**. Those were old agents and dev servers from earlier sessions, and they're easy to forget about. Herdr's terminals also outlive its window (`hc`), but they show up in the Projects sidebar and the Resource Manager.
4. **Idle CPU is similar, around 5–6% of one core.** Neither app is a CPU problem at rest.

## Limits

- **Not a clean machine.** Both apps carried the person's real workspaces: 13–18 terminals with live agents. The app-only numbers are still comparable; the "inside" numbers are not a like-for-like workload.
- **Rendering under load wasn't tested.** For example, `seq 1 3000000` in a visible terminal in each app would show which one draws output more cheaply. It needs the terminal on screen in both apps at once, which would have taken over the person's window.
- **One run each.** Memory moved by about ±60 MB between Orca runs, which is garbage collection and caches.
- **The Resource Manager chip shows RSS ("Σ RSS"),** so it undercounts Herdr's own memory (about 81 MB shown against 333 MB real). Switching it to `phys_footprint` (via `footprint`, or Orca's approach) would make it match Activity Monitor.

## Rerun it

```bash
node docs/benchmarks/measure.js 30 my-label   # prints JSON for both apps
```

Run it with nothing streaming in either app, to get quiet CPU numbers.
