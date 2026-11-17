// Pure, import-free grouping logic for the projects sidebar mod.

function repoName(primary) {
  if (!primary) return "";
  const trimmed = primary.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function placeOf(space, panes = []) {
  if (!space) return "";
  const tabs = space.tabs;
  if (Array.isArray(tabs) && tabs.length > 0 && Array.isArray(panes)) {
    const tabIds = new Set(tabs.map((t) => t.id));
    for (const p of panes) {
      if (p && tabIds.has(p.tab) && typeof p.cwd === "string" && p.cwd.length > 0) {
        return p.cwd;
      }
    }
  }
  return space.folder ?? "";
}

export function letterOf(name) {
  const last = name.split(".").filter(Boolean).pop() ?? "";
  return (last.match(/[a-z0-9]/i)?.[0] ?? name.match(/[a-z]/i)?.[0] ?? "?").toUpperCase();
}

export function colorIndex(path, n) {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (Math.imul(hash, 31) + path.charCodeAt(i)) >>> 0;
  }
  return hash % n;
}

export function stripLogin(branch, logins) {
  const slash = branch.indexOf("/");
  if (slash > 0 && slash < branch.length - 1
    && logins.some((login) => login.toLowerCase() === branch.slice(0, slash).toLowerCase())) {
    return branch.slice(slash + 1);
  }
  return branch;
}

export function label(input, logins = []) {
  if (!input) return "";
  if ("space" in input) {
    if (input.space === null) {
      return input.sleeping?.branch ? stripLogin(input.sleeping.branch, logins) : repoName(input.worktree);
    }
    const s = input.space;
    return s.named ? s.name : (s.branch != null ? stripLogin(s.branch, logins) : s.name);
  }
  return input.named ? input.name : (input.branch != null ? stripLogin(input.branch, logins) : input.name);
}

export function visibleRows(g, collapsed) {
  if (!g || !Array.isArray(g.rows)) return [];
  if (collapsed) {
    return g.rows.filter((r) => Boolean(r.space?.active));
  }
  return g.rows;
}

export function group(spaces = [], placeOf = (s) => s?.folder ?? "", repoOf = () => null, opts = {}) {
  const prevKeyOf = opts?.prevKeyOf ?? (() => undefined);
  const giveUp = opts?.giveUp ?? (() => false);
  const saved = Array.isArray(opts?.saved) ? opts.saved : [];
  const savedByPath = new Map();
  for (const s of saved) {
    if (s && typeof s.path === "string" && !savedByPath.has(s.path)) {
      savedByPath.set(s.path, s);
    }
  }
  const sleeping = opts?.sleeping && typeof opts.sleeping === "object" ? opts.sleeping : null;

  // Pass 1: Classify spaces and discover all definitive group keys this round
  const items = [];
  const knownKeys = new Set();

  for (const s of spaces) {
    if (s.machine !== null && s.machine !== undefined) {
      const key = "machine:" + s.machine;
      knownKeys.add(key);
      items.push({ space: s, type: "machine", key });
    } else {
      const place = placeOf(s);
      const repo = repoOf(place);
      if (repo && typeof repo === "object" && repo.primary) {
        const key = repo.primary;
        knownKeys.add(key);
        items.push({ space: s, type: "repo", key, repo });
      } else if (repo === null) {
        knownKeys.add("other");
        items.push({ space: s, type: "other", key: "other" });
      } else {
        // repo === undefined (unprobed)
        items.push({ space: s, type: "unprobed" });
      }
    }
  }

  // If any unprobed space will fall back to "other" via giveUp, mark "other" as an existing group
  for (const item of items) {
    if (item.type === "unprobed") {
      const prevKey = prevKeyOf(item.space.id);
      if ((!prevKey || !knownKeys.has(prevKey)) && giveUp(item.space.id)) {
        knownKeys.add("other");
      }
    }
  }

  // Pass 2: Assign unprobed spaces and build groups preserving first-space order
  const groupsMap = new Map();

  function getOrCreateGroup(key, type) {
    let g = groupsMap.get(key);
    if (!g) {
      if (type === "machine") {
        const name = key.slice("machine:".length);
        g = { key, name, kind: "machine", primary: null, primarySpace: null, rows: [] };
      } else if (type === "other" || key === "other") {
        g = { key: "other", name: "Other", kind: "other", primary: null, primarySpace: null, rows: [] };
      } else {
        const name = repoName(key);
        g = { key, name, kind: "repo", primary: key, primarySpace: null, rows: [] };
      }
      groupsMap.set(key, g);
    }
    return g;
  }

  const matchedWorktrees = new Set();
  const makeRow = (space, main, place) => {
    const rec = sleeping && place && Object.prototype.hasOwnProperty.call(sleeping, place) ? sleeping[place] : null;
    if (rec) {
      matchedWorktrees.add(place);
      return { space, main, sleeping: rec };
    }
    return { space, main };
  };

  for (const item of items) {
    if (item.type === "machine") {
      const g = getOrCreateGroup(item.key, "machine");
      g.rows.push({ space: item.space, main: false });
    } else if (item.type === "repo") {
      const g = getOrCreateGroup(item.key, "repo");
      g.rows.push(makeRow(item.space, item.repo.linked === false, placeOf(item.space)));
    } else if (item.type === "other") {
      const g = getOrCreateGroup("other", "other");
      g.rows.push({ space: item.space, main: false });
    } else {
      // unprobed space
      const prevKey = prevKeyOf(item.space.id);
      if (prevKey && knownKeys.has(prevKey)) {
        const type = prevKey.startsWith("machine:") ? "machine" : (prevKey === "other" ? "other" : "repo");
        const g = getOrCreateGroup(prevKey, type);
        g.rows.push(type === "repo" ? makeRow(item.space, false, placeOf(item.space)) : { space: item.space, main: false });
      } else if (giveUp(item.space.id)) {
        const g = getOrCreateGroup("other", "other");
        g.rows.push({ space: item.space, main: false });
      } else {
        // Space is omitted
      }
    }
  }

  // Finalize each group: stable sort rows by main first, then calculate primarySpace
  for (const g of groupsMap.values()) {
    if (g.kind === "repo") {
      g.rows.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
      const mainRow = g.rows.find((r) => r.main);
      g.primarySpace = mainRow ? mainRow.space.id : null;
    } else {
      g.primarySpace = null;
    }
  }

  // Group order: insertion order (first space in spaces), then saved-only in saved order, with "other" always last
  const result = [];
  let otherGroup = null;
  for (const g of groupsMap.values()) {
    if (g.key === "other") {
      otherGroup = g;
    } else {
      if (savedByPath.has(g.key)) {
        g.saved = true;
        g.exists = Boolean(savedByPath.get(g.key).exists);
      }
      result.push(g);
    }
  }
  for (const [path, saved] of savedByPath) {
    if (!groupsMap.has(path)) {
      result.push({
        key: path,
        name: repoName(path),
        kind: "repo",
        primary: path,
        primarySpace: null,
        rows: [],
        saved: true,
        exists: Boolean(saved.exists),
      });
    }
  }
  if (otherGroup) {
    result.push(otherGroup);
  }

  for (const g of result) {
    if (g.kind !== "repo") continue;
    const saved = savedByPath.get(g.key);
    g.displayName = saved?.name || g.name;
    g.icon = saved?.icon ?? null;
  }

  if (sleeping) {
    const extraByRepo = new Map();
    for (const [worktree, record] of Object.entries(sleeping)) {
      if (!record || matchedWorktrees.has(worktree) || !record.repo) continue;
      let list = extraByRepo.get(record.repo);
      if (!list) {
        list = [];
        extraByRepo.set(record.repo, list);
      }
      list.push({ space: null, worktree, sleeping: record, main: false });
    }
    for (const g of result) {
      if (g.kind !== "repo") continue;
      const extras = extraByRepo.get(g.key);
      if (!extras || extras.length === 0) continue;
      extras.sort((a, b) => (b.sleeping?.sleptAt ?? 0) - (a.sleeping?.sleptAt ?? 0));
      g.rows.push(...extras);
    }
  }

  return result;
}

/** Group agents by their `space` id while preserving input order. */
export function agentsBySpace(agents = []) {
  const bySpace = new Map();
  if (!Array.isArray(agents)) return bySpace;
  for (const a of agents) {
    if (!a || a.space == null) continue;
    let list = bySpace.get(a.space);
    if (!list) {
      list = [];
      bySpace.set(a.space, list);
    }
    list.push(a);
  }
  return bySpace;
}

/** Track the timestamp when each active agent entered its current status. */
export function sinceUpdate(prev, agents = [], now = Date.now()) {
  const next = new Map();
  if (!Array.isArray(agents)) return next;
  for (const a of agents) {
    if (!a || a.address == null) continue;
    const entry = prev?.get(a.address);
    next.set(
      a.address,
      entry && entry.status === a.status ? entry : { status: a.status, at: now }
    );
  }
  return next;
}

/** Format a duration in milliseconds as `""`, `"Nm"`, or `"Nh"`. */
export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return "";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

const ACTIVITY_RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

/** Sort agents by attention priority, then newest status-change timestamp first. */
export function activitySort(agents = [], sinceMap) {
  if (!Array.isArray(agents)) return [];
  const rank = (s) => ACTIVITY_RANK[s] ?? 4;
  const sinceAt = (a) => sinceMap?.get(a?.address)?.at ?? 0;
  return [...agents].sort((a, b) => rank(a?.status) - rank(b?.status) || sinceAt(b) - sinceAt(a));
}

/** Count agents currently needing attention (`blocked` or `done`). */
export function attentionCount(agents = []) {
  if (!Array.isArray(agents)) return 0;
  let n = 0;
  for (const a of agents) {
    if (a?.status === "blocked" || a?.status === "done") n++;
  }
  return n;
}

/** Sort project groups by `"added"` (input order) or `"name"` (repos alphabetically, machines, then other). */
export function sortGroups(groups = [], sort = "added") {
  if (!Array.isArray(groups)) return [];
  if (sort !== "name") return [...groups];
  const repos = [];
  const machines = [];
  const others = [];
  for (const g of groups) {
    if (g?.kind === "repo") repos.push(g);
    else if (g?.kind === "machine") machines.push(g);
    else others.push(g);
  }
  repos.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));
  return [...repos, ...machines, ...others];
}

/** Return copies of groups with main checkout rows removed, preserving all group headers. */
export function hideMainRows(groups = []) {
  if (!Array.isArray(groups)) return [];
  return groups.map((g) => ({
    ...g,
    rows: Array.isArray(g.rows) ? g.rows.filter((r) => !r.main) : [],
  }));
}

export const STATUS_GLYPH = { blocked: "!", working: "●", done: "✓", idle: "○" };

const URGENCY_ORDER = ["blocked", "working", "done", "idle"];

/** Return the most urgent known agent status, or `null` when none are known. */
export function topStatus(agents = []) {
  if (!Array.isArray(agents) || agents.length === 0) return null;
  let bestIdx = URGENCY_ORDER.length;
  for (const a of agents) {
    const idx = URGENCY_ORDER.indexOf(a?.status);
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      if (bestIdx === 0) break;
    }
  }
  return bestIdx < URGENCY_ORDER.length ? URGENCY_ORDER[bestIdx] : null;
}

/** Cap agent icons for the folded card strip and report the overflow count. */
export function agentSummary(agents = [], max = 5) {
  const list = Array.isArray(agents) ? agents : [];
  return {
    icons: list.slice(0, max),
    more: Math.max(0, list.length - max),
  };
}
