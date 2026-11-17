# Resource manager

## Why

The person wants to see what their terminals and agents cost in CPU and memory, out of interest. Orca has a Resource Manager for this: a status-bar chip and a popover with Resources and PTYs tabs. We follow it, from the person's screenshots and Orca's source (`~/jimmy_dev/orca/src/renderer/src/components/status-bar/resources/`, read 2026-11-17).

## Goals

### Status-bar chip

- The chip shows `▭ 2.14 GB · >_ 5`: total memory of every Herdr terminal's process tree plus the Herdr app, then the number of live Herdr terminals.
- It sits in the `orca-strip` row of the `orca` layout, between `orca-usage` and `orca-setup`.
- Clicking it opens the popover above the status bar, the same way the usage popup does: borderless, anchored above the chip, and fitted to the window.

### Popover header

- Title **Resource Manager** with a chip glyph, then a **Refresh** button that samples now.
- Then two tabs, **Resources** and **PTYs** (the PTYs tab shows its count in a pill). The last tab chosen is remembered in `localStorage`.

### Resources tab

- **Summary line:** `3.5%  2.19 GB Σ RSS`, the total CPU (summed per-core percent, so it can exceed 100) and the total memory.
- Under it, a **▸ Metric details** fold that explains both numbers:
  - CPU is the sum of each process's `%cpu` from `ps`.
  - Memory is the resident memory (RSS) of each terminal's process and all its children.
- **Table columns:** Name, CPU, Mem. Clicking a column header sorts by it. The default is Mem, descending.
- **Row levels:**
  1. Project, in caps. It folds.
  2. Worktree. It folds, and has a sparkline of its memory over the last 2 minutes.
  3. Terminal. A green dot, then its label: the Herdr tab name, else `pid N`.
- A **Herdr** row sits at the bottom, folded by default. It holds the Herdr app and its own helper processes, not the terminals.
- Clicking a terminal row focuses that terminal (`pane.focus`, or `space.select` and then focus).
- Projects and worktrees are worked out the way the sidebar does it: terminal → space (`labels["herdr.space"]`) → `placeOf(space)` → repo. Terminals with no space go under **Other terminals**.

### PTYs tab

- **Top lines:**
  - `N Herdr terminals on this computer`
  - `Last observed <time>`
  - a **Select all** checkbox, and **End selected (n)**, which is disabled at 0.
- **Rows:** grouped by project, then worktree, each with its count. Each row has:
  - a checkbox;
  - a `›` that unfolds the details: address (`t25`), PID, folder, the program running now, and when it started;
  - the label;
  - `↗`, which jumps to the terminal;
  - **End**, which runs `hc kill <t>`. Herdr hangs the terminal up, then escalates.
- **End and End selected ask once for confirmation:** "End N terminal(s) and their processes?" Ending a terminal that runs an agent says so in the question.

### Sampling

- Every **2 s** while the popover is open, and every **5 s** otherwise (for the chip).
- **One sample** is two commands:
  - `ps -axo pid=,ppid=,pcpu=,rss=`, run with `LC_ALL=C`;
  - `hc ls --json`, plus `hc get` for each terminal's `pid`. Use one call if `hc ls --all --json` or a similar call carries the pid. The builder checks this.
- Each terminal's numbers are its shell's pid plus every descendant. A process is counted once, in the first terminal that claims it.
- **Sparklines:** keep 60 samples per worktree in memory, about 2 minutes at 2 s. A worktree unseen for 10 minutes is dropped.

## Non-goals

- Orca's trash icon (end all terminals), its daemon restart button, the **Clean up workspaces** screen, the disk-space panel, and orphan-terminal handling.
- macOS `phys_footprint` memory. We use RSS and say so ("Σ RSS").
- Browser rows, remote machines, and Windows.

## Anti-goals

- **The chip must not slow Herdr down.**
  - A sample may not block the UI thread. It runs inside `cx.spawn`.
  - A new sample is skipped while the last one is still running.
- **End never fires without a confirmation.** It never touches a terminal other than the ones checked.

## Approaches

- **A. The mod samples and adds up the numbers itself (picked).**
  - The mod calls `exec("ps")` and `hc` directly. A pure helper adds up the process trees.
  - It's cheap, with no Node process started every 2 s, and it can use Herdr's space and tab names.
- B. An `orca-wt resources` CLI command. Rejected: it starts a Node process every 2 s, and it can't see tab names.
- C. A background sampler writing to a file. Rejected: one more process to keep alive, which is too much for a hobby tracker.

## Design notes

- **New mods:**
  - `mods/orca-resources/`: the chip, the sampler, and the shared state.
  - `mods/orca-resources-panel/`: the popover.

  They mirror `orca-usage` and `orca-usage-panel`. The chip publishes each sample with `setShared("orca.resources", snapshot)`, and the panel reads it. The panel sets `shared("orca.resources.open")` so the chip samples faster while it's open.
- **Pure helpers in `mods/orca-resources/tree.js`, unit-tested:**
  - `parsePs(text)` returns `Map<pid, {ppid, cpu, rss}>`.
  - `subtreeTotals(procs, roots)` returns `{pid → {cpu, rss, pids}}`, counting each pid once and in root order.
  - `resourceTree(terminals, totals, spaceOf, placeOf, repoOf)` builds the project → worktree → terminal rows with summed totals.
  - `pushHistory(hist, key, value, now)` keeps the 60-sample ring and does the 10-minute drop.
  - `fmtMem(kb)` formats `720.8 MB` and `1.07 GB`.
- **The Herdr row:** the Herdr app is `ps` processes whose command path contains `Herdr.app`, plus their children that aren't terminals.
- **Layout:** `scripts/install.sh` doesn't touch layouts. The builder adds the block to `~/.config/herdr-app/layouts/orca.json`, after checking the current file, and documents that one-time step in the README.

## Calls made after the builder check

- **The Herdr row** covers:
  - the `Herdr.app` process tree;
  - every `herdr-core` process: the daemon in `Herdr Core.app` and `~/.local/bin/herdr-core`. The terminals run under the daemon, not under `Herdr.app`.

  The walk stops at terminal shell pids, so terminal processes are never counted twice. The chip's memory is the terminals plus the Herdr row.
- **Which terminals count:**
  - **Herdr terminals** are the ones with a `herdr.space` label, meaning they're shown in a Herdr space. Only they count in the chip's `>_ N`, in "N Herdr terminals", and in the PTYs tab's rows and Select all.
  - Unlabelled terminals, such as sub-agents started with `hc run`, show only in the Resources tab under **Other terminals**, with no End.
  - Remote terminals (an address with `/`, like `vps/t7`) are skipped, because their pids aren't on this Mac.
- **The worktree row is the terminal's place (`placeOf(space)`), and the project is that place's repo.**
  - A place with no repo becomes its own project, named after the folder.
  - Project groups and sleeping spaces aren't shown here. This tab is about live processes.
- **Memory follows the terminal's shell `pid` and all its descendants,** which includes the agent and the agent's children.
  - A terminal's pid doesn't change, so it's looked up once per new address and cached. The builder uses `terminals()` if it carries `pid`, and `hc get <t> --json` otherwise.
  - A steady sample is therefore only `ps` plus `hc ls --json`.
- **PTY details** show `foreground.argv`, fetched with one `hc get` when a row is unfolded.
- **The End question names an agent** when the terminal's `agent` isn't a shell (`zsh`, `bash`, `fish` or `sh`).

## Left to the builder

- Exact sizes, colours and glyphs. Reuse the usage panel's card style.
- The sparkline drawing: a small svg polyline, or a row of thin bars if gpui-kit has no polyline.
- Whether `repoOf` comes from the projects sidebar's shared data or is worked out again.
