// Pure, import-free process tree and snapshot helpers for the resource manager.

const SHELLS = new Set(["zsh", "bash", "fish", "sh"]);
const HISTORY_MAX = 60;
const HISTORY_TTL_MS = 600000;
const KB_PER_GB = 1048576;

function baseName(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function buildChildrenMap(procs) {
  const children = new Map();
  for (const [pid, info] of procs) {
    let list = children.get(info.ppid);
    if (!list) {
      list = [];
      children.set(info.ppid, list);
    }
    list.push(pid);
  }
  return children;
}

/** Parse `ps -axo pid=,ppid=,pcpu=,rss=` output into a Map by pid. */
export function parsePs(text) {
  const procs = new Map();
  if (!text) return procs;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    const cpu = Number.parseFloat(parts[2]);
    const rss = Number.parseInt(parts[3], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    procs.set(pid, {
      ppid,
      cpu: Number.isFinite(cpu) ? cpu : 0,
      rss: Number.isFinite(rss) ? rss : 0,
    });
  }
  return procs;
}

/** Sum cpu and rss for each root's subtree, claiming each pid at most once in root order. */
export function subtreeTotals(procs, roots) {
  const children = buildChildrenMap(procs);
  const claimed = new Set();
  const out = new Map();

  for (const root of roots) {
    let cpu = 0;
    let rss = 0;
    const pids = [];
    if (procs.has(root) && !claimed.has(root)) {
      const stack = [root];
      while (stack.length > 0) {
        const pid = stack.pop();
        if (claimed.has(pid)) continue;
        const info = procs.get(pid);
        if (!info) continue;
        claimed.add(pid);
        cpu += info.cpu;
        rss += info.rss;
        pids.push(pid);
        const kids = children.get(pid);
        if (kids) {
          for (let i = kids.length - 1; i >= 0; i--) {
            if (!claimed.has(kids[i])) stack.push(kids[i]);
          }
        }
      }
    }
    out.set(root, { cpu, rss, pids });
  }
  return out;
}

/** Sum cpu and rss for Herdr.app and herdr-core processes and their descendants, stopping at stopAt pids. */
export function herdrTotals(procs, commands, stopAt = new Set()) {
  const children = buildChildrenMap(procs);
  const visited = new Set();
  let cpu = 0;
  let rss = 0;

  for (const [pid] of procs) {
    const cmd = commands.get(pid) ?? "";
    if (!cmd.includes("/Herdr.app/") && !cmd.includes("herdr-core")) continue;
    if (visited.has(pid) || stopAt.has(pid)) continue;
    const stack = [pid];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (visited.has(cur) || stopAt.has(cur)) continue;
      const info = procs.get(cur);
      if (!info) continue;
      visited.add(cur);
      cpu += info.cpu;
      rss += info.rss;
      const kids = children.get(cur);
      if (kids) {
        for (let i = kids.length - 1; i >= 0; i--) {
          if (!visited.has(kids[i]) && !stopAt.has(kids[i])) stack.push(kids[i]);
        }
      }
    }
  }
  return { cpu, rss };
}

/** Build the complete resource snapshot from terminals, process totals, and Herdr totals. */
export function buildSnapshot({ terminals, totals, herdr, placeOf, repoOf, now }) {
  const herdrRow = { cpu: herdr?.cpu ?? 0, rss: herdr?.rss ?? 0 };
  let totalCpu = herdrRow.cpu;
  let totalRss = herdrRow.rss;
  let count = 0;

  const projectMap = new Map();
  const other = [];

  for (const t of terminals) {
    const stat = (t.pid != null && totals.get(t.pid)) || { cpu: 0, rss: 0 };
    const row = {
      address: t.address,
      pid: t.pid ?? null,
      label: t.label || (t.pid != null ? `pid ${t.pid}` : t.address),
      agent: t.agent || "",
      cpu: stat.cpu,
      rss: stat.rss,
    };
    totalCpu += row.cpu;
    totalRss += row.rss;

    if (!t.space) {
      other.push(row);
      continue;
    }

    count += 1;
    const place = placeOf(t.space) || t.folder || "";
    const repo = repoOf(place) || { key: place, name: baseName(place) || place };
    const projKey = repo.key ?? repo.primary ?? place;
    const projName = repo.name || baseName(projKey) || projKey;

    let project = projectMap.get(projKey);
    if (!project) {
      project = { key: projKey, name: projName, cpu: 0, rss: 0, worktrees: new Map() };
      projectMap.set(projKey, project);
    }
    project.cpu += row.cpu;
    project.rss += row.rss;

    const wtKey = place;
    let wt = project.worktrees.get(wtKey);
    if (!wt) {
      wt = {
        key: wtKey,
        name: t.space.name || baseName(place) || place,
        cpu: 0,
        rss: 0,
        terminals: [],
      };
      project.worktrees.set(wtKey, wt);
    }
    wt.cpu += row.cpu;
    wt.rss += row.rss;
    wt.terminals.push(row);
  }

  const projects = Array.from(projectMap.values()).map((p) => ({
    key: p.key,
    name: p.name,
    cpu: p.cpu,
    rss: p.rss,
    worktrees: Array.from(p.worktrees.values()),
  }));

  return {
    at: now,
    cpu: totalCpu,
    rss: totalRss,
    count,
    herdr: herdrRow,
    projects,
    other,
  };
}

/** Append a value to a bounded 60-point history map and prune stale keys unseen for 10 minutes. */
export function pushHistory(hist, key, value, now) {
  let entry = hist.get(key);
  if (!entry) {
    entry = { points: [], seen: now };
    hist.set(key, entry);
  }
  entry.points.push(value);
  if (entry.points.length > HISTORY_MAX) {
    entry.points.splice(0, entry.points.length - HISTORY_MAX);
  }
  entry.seen = now;

  for (const [k, v] of hist) {
    if (now - v.seen > HISTORY_TTL_MS) {
      hist.delete(k);
    }
  }
}

/** Format kilobytes as MB (< 1 GB) or GB (>= 1 GB). */
export function fmtMem(kb) {
  const n = Number.isFinite(kb) ? kb : 0;
  if (n < KB_PER_GB) return `${(n / 1024).toFixed(1)} MB`;
  return `${(n / KB_PER_GB).toFixed(2)} GB`;
}

/** Format CPU percentage with 1 decimal place. */
export function fmtCpu(n) {
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
}

/** Return true when the foreground program is an agent rather than an interactive shell. */
export function isAgent(agent) {
  if (!agent) return false;
  return !SHELLS.has(String(agent).toLowerCase());
}
