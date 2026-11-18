import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  theme,
  exec,
  openOverlay,
  shared,
  setShared,
  spaces,
  panes,
  terminals,
  checking,
  window,
  watchFolder,
} from "herdr";
import config from "./config.js";
import {
  parsePs,
  parseProcessSnapshot,
  subtreeTotals,
  herdrTotals,
  buildSnapshot,
  pushHistory,
  fmtMem,
} from "./tree.js";
import { placeOf } from "./place.js";

const METADATA_RETRY_MS = 5000;
const REPO_RECONCILE_MS = 60000;
const REPO_WATCH_DEBOUNCE_MS = 250;
const TERMINAL_LOOKUP_WORKERS = 4;

function terminalLabels(labels) {
  return labels && typeof labels === "object" && !Array.isArray(labels) ? labels : null;
}

function baseName(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function repoWatchPath(parsed) {
  const commonDir = parsed.gitCommonDir;
  return typeof commonDir === "string" && commonDir.startsWith("/")
    ? commonDir.replace(/\/+$/, "") + "/worktrees"
    : null;
}

function affectsRepo(path, root) {
  if (path === root) return true;
  if (typeof path !== "string" || !path.startsWith(root + "/")) return false;
  const [, metadata, child] = path.slice(root.length + 1).split("/", 3);
  return !metadata || (child === undefined && /^(gitdir|commondir)(\.lock)?$/.test(metadata));
}

function parseCommands(text) {
  const map = new Map();
  if (!text) return map;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = line.search(/\s/);
    if (sp <= 0) continue;
    const pid = Number.parseInt(line.slice(0, sp), 10);
    const cmd = line.slice(sp + 1).trim();
    if (Number.isFinite(pid) && cmd) map.set(pid, cmd);
  }
  return map;
}

function windowActive() {
  try {
    return typeof window === "function" ? window()?.active : undefined;
  } catch {
    return undefined;
  }
}

export default class OrcaResources extends View {
  init(_p, cx) {
    this.snapshot = shared("orca.resources") ?? null;
    this.sampling = false;
    this.samplePending = false;
    this.destroyed = false;
    this.sampleTimer = null;
    this.processFormat = null;
    this.lastSampleAt = 0;
    this.lastRefresh = shared("orca.resources.refresh")?.at ?? null;
    this.termCache = new Map();
    this.terminalPlaces = new Map();
    this.repoCache = new Map();
    this.repoWatches = new Map();
    this.history = new Map();

    if (checking()) return;

    this.popupOpen = Boolean(shared("orca.resources.open"));
    this.lastWindowActive = windowActive();
    this.requestSample(cx);
    this.sampleTimer = cx.timer.every(1000, (cx) => this.tick(cx));
  }

  destroy() {
    this.destroyed = true;
    this.samplePending = false;
    this.sampleTimer?.cancel();
    this.sampleTimer = null;
    this.cancelRepoWatches();
  }

  requestSample(cx) {
    if (this.destroyed || checking()) return;
    if (this.sampling) {
      this.samplePending = true;
    } else {
      this.sample(cx);
    }
  }

  tick(cx) {
    if (this.destroyed || checking()) return;

    const open = Boolean(shared("orca.resources.open"));
    const active = windowActive();
    const refresh = shared("orca.resources.refresh")?.at;
    const refreshRequested = refresh != null && refresh !== this.lastRefresh;
    const popupOpened = open && !this.popupOpen;
    const focusReturned = active === true && this.lastWindowActive === false;
    this.popupOpen = open;
    if (typeof active === "boolean") this.lastWindowActive = active;

    if (popupOpened || focusReturned || refreshRequested) {
      this.requestSample(cx);
      if (refreshRequested) this.lastRefresh = refresh;
      return;
    }

    const interval = open ? 2000 : active === false ? 30000 : 15000;
    if (Date.now() - this.lastSampleAt >= interval) this.sample(cx);
  }

  cancelRepoWatches() {
    const watches = [...this.repoWatches.values()];
    this.repoWatches.clear();
    for (const watch of watches) watch.handle?.cancel();
  }

  armRepoWatch(path, watch) {
    try {
      const handle = watchFolder(path);
      watch.handle = handle;
      const finish = (paths) => {
        if (this.destroyed || this.repoWatches.get(path) !== watch || watch.handle !== handle) return;
        watch.handle = null;
        if (!paths?.length) {
          watch.retryAt = Date.now() + REPO_RECONCILE_MS;
          return;
        }
        if (paths.some((changed) => affectsRepo(changed, path))) {
          watch.dirtyAt = Date.now() + REPO_WATCH_DEBOUNCE_MS;
        }
        this.armRepoWatch(path, watch);
      };
      handle.then(finish, () => finish([]));
    } catch {
      watch.handle = null;
      watch.retryAt = Date.now() + REPO_RECONCILE_MS;
    }
  }

  pruneRepoMetadata(activePlaces) {
    for (const place of this.repoCache.keys()) {
      if (!activePlaces.has(place)) this.repoCache.delete(place);
    }
    for (const [path, watch] of this.repoWatches) {
      for (const place of watch.places) {
        if (!activePlaces.has(place)) watch.places.delete(place);
      }
      if (watch.places.size) continue;
      this.repoWatches.delete(path);
      watch.handle?.cancel();
    }
  }

  syncRepoWatches(_cx, activePlaces, now) {
    if (typeof watchFolder !== "function") return;
    const placesByPath = new Map();
    for (const place of activePlaces) {
      const path = this.repoCache.get(place)?.watchPath;
      if (!path) continue;
      if (!placesByPath.has(path)) placesByPath.set(path, new Set());
      placesByPath.get(path).add(place);
    }
    for (const [path, watch] of this.repoWatches) {
      if (placesByPath.has(path)) continue;
      this.repoWatches.delete(path);
      watch.handle?.cancel();
    }
    for (const [path, places] of placesByPath) {
      let watch = this.repoWatches.get(path);
      if (!watch) {
        watch = { handle: null, places, dirtyAt: null, retryAt: 0, validateAfterSubscribe: false };
        this.repoWatches.set(path, watch);
      }
      watch.places = places;
      if (!watch.handle && now >= watch.retryAt) {
        this.armRepoWatch(path, watch);
        // Close the gap between reading repo metadata and registering the watch.
        watch.validateAfterSubscribe = Boolean(watch.handle);
      }
    }
  }

  invalidateRepoWatches(now) {
    for (const watch of this.repoWatches.values()) {
      const due = watch.dirtyAt == null
        ? watch.handle && watch.validateAfterSubscribe
        : now >= watch.dirtyAt;
      if (!due) continue;
      watch.dirtyAt = null;
      watch.validateAfterSubscribe = false;
      for (const place of watch.places) {
        const cached = this.repoCache.get(place);
        if (cached) cached.freshAt = null;
      }
    }
  }

  async resolveRepo(place, now) {
    if (!place) return { key: "", name: "" };
    const fallback = { key: place, name: baseName(place) || place };
    const cached = this.repoCache.get(place);
    const watched = this.repoWatches.get(cached?.watchPath)?.handle;
    const fresh = cached?.freshAt != null && (watched || now - cached.freshAt < REPO_RECONCILE_MS);
    if (fresh || now < cached?.retryAt) return cached.result ?? fallback;

    try {
      const res = await exec(config.node, [config.cli, "info", place], { timeout: 10000 });
      if (res.code === 0) {
        const parsed = JSON.parse(res.stdout);
        if (typeof parsed?.primary === "string" && parsed.primary && !parsed.error) {
          const result = { key: parsed.primary, name: baseName(parsed.primary) || parsed.primary };
          this.repoCache.set(place, {
            result, watchPath: repoWatchPath(parsed), freshAt: Date.now(), retryAt: 0,
          });
          return result;
        }
        if (parsed?.error === "not a git repository") {
          this.repoCache.set(place, { result: null, freshAt: Date.now(), retryAt: 0 });
          return fallback;
        }
      }
    } catch {}
    const result = cached?.result ?? null;
    this.repoCache.set(place, {
      result, watchPath: cached?.watchPath, freshAt: null, retryAt: Date.now() + METADATA_RETRY_MS,
    });
    return result ?? fallback;
  }

  async resolveTerminalMeta(entry, herdrByAddress, now) {
    const address = entry.address;
    const host = herdrByAddress.get(address);
    const currentPid = entry.pid ?? host?.pid ?? null;
    const currentLabels = terminalLabels(entry.labels) ?? terminalLabels(host?.labels);
    let cached = this.termCache.get(address);
    if (currentPid != null && cached?.pid != null && currentPid !== cached.pid) {
      cached = undefined;
    }

    let pid = currentPid ?? cached?.pid ?? null;
    let labels = currentLabels ?? cached?.labels ?? null;
    let retryAt = cached?.retryAt ?? 0;
    if ((pid == null || labels == null) && now >= retryAt) {
      try {
        const res = await exec("hc", ["get", address, "--json"], { timeout: 5000 });
        if (res.code === 0) {
          const info = JSON.parse(res.stdout);
          const fetchedPid = info?.pid ?? null;
          if (currentPid == null || fetchedPid == null || currentPid === fetchedPid) {
            if (pid != null && fetchedPid != null && pid !== fetchedPid) labels = currentLabels;
            pid = currentPid ?? fetchedPid ?? pid;
            labels ??= terminalLabels(info?.labels);
          }
        }
      } catch {}
      retryAt = Date.now() + METADATA_RETRY_MS;
    }
    this.termCache.set(address, { pid, labels, retryAt: pid != null && labels != null ? 0 : retryAt });
    return {
      pid,
      spaceId: labels?.["herdr.space"] ?? null,
      tabId: labels?.["herdr.tab"] ?? null,
    };
  }

  async resolveTerminalMetas(entries, herdrByAddress, now) {
    const metas = new Array(entries.length);
    let next = 0;
    const worker = async () => {
      while (!this.destroyed && next < entries.length) {
        const index = next++;
        metas[index] = await this.resolveTerminalMeta(entries[index], herdrByAddress, now);
      }
    };
    await Promise.all(Array.from({ length: Math.min(entries.length, TERMINAL_LOOKUP_WORKERS) }, worker));
    return metas;
  }

  async collectProcesses() {
    if (this.processFormat !== "legacy") {
      const res = await exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,comm="], { timeout: 10000 });
      if (res?.code === 0) {
        const snapshot = parseProcessSnapshot(res.stdout);
        if (snapshot) {
          this.processFormat = "combined";
          return snapshot;
        }
        if (this.processFormat === "combined") throw new Error("Unusable combined process scan");
      } else if (/keyword not found|unknown (?:user-defined )?(?:format|keyword|specifier)|bad (?:format|keyword|specifier)|unsupported (?:format|keyword|specifier)/i.test(res?.stderr ?? "")) {
        this.processFormat = "legacy";
      } else {
        throw new Error("Combined process scan failed");
      }
    }

    if (this.destroyed) throw new Error("Resource sampler destroyed");
    const [psResult, commResult] = await Promise.allSettled([
      exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { timeout: 10000 }),
      exec("ps", ["-axo", "pid=,comm="], { timeout: 10000 }),
    ]);
    if (psResult.status !== "fulfilled" || commResult.status !== "fulfilled" ||
        psResult.value?.code !== 0 || commResult.value?.code !== 0) {
      throw new Error("Legacy process scan failed");
    }
    const procs = parsePs(psResult.value.stdout);
    const commands = parseCommands(commResult.value.stdout);
    if (!procs.size || !commands.size) throw new Error("Unusable legacy process scan");
    this.processFormat = "legacy";
    return { procs, commands };
  }

  sample(cx) {
    if (this.destroyed || this.sampling || checking()) return;
    this.sampling = true;

    cx.spawn(async (cx) => {
      try {
        if (this.destroyed) return;
        const [processes, terminalsResult] = await Promise.allSettled([
          this.collectProcesses(),
          exec("hc", ["ls", "--json"], { timeout: 5000 }),
        ]);
        if (this.destroyed || terminalsResult.status !== "fulfilled" ||
            terminalsResult.value?.code !== 0) return;

        const hcEntries = JSON.parse(terminalsResult.value.stdout)?.terminals;
        if (!Array.isArray(hcEntries)) return;

        const liveEntries = hcEntries.filter(
          (e) => e && e.state === "live" && typeof e.address === "string" && !e.address.includes("/"),
        );

        const addresses = new Set(liveEntries.map((entry) => entry.address));
        for (const address of this.termCache.keys()) {
          if (!addresses.has(address)) this.termCache.delete(address);
        }

        for (const address of this.terminalPlaces.keys()) {
          if (!addresses.has(address)) this.terminalPlaces.delete(address);
        }

        if (!liveEntries.length) {
          this.repoCache.clear();
          this.cancelRepoWatches();
        }
        if (processes.status !== "fulfilled") {
          this.pruneRepoMetadata(new Set(this.terminalPlaces.values()));
          return;
        }
        const { procs, commands } = processes.value;

        const sps = spaces();
        const psList = panes();
        const herdrTerms = typeof terminals === "function" ? terminals() : [];
        const herdrByAddress = new Map(herdrTerms.map((terminal) => [terminal.address, terminal]));
        const spaceById = new Map(sps.map((s) => [s.id, s]));
        const metadataAt = Date.now();
        const metas = await this.resolveTerminalMetas(liveEntries, herdrByAddress, metadataAt);
        if (this.destroyed) return;

        const termRows = [];
        const places = new Set();
        this.terminalPlaces.clear();
        const roots = [];

        for (let i = 0; i < liveEntries.length; i++) {
          const entry = liveEntries[i];
          const meta = metas[i];
          const space = meta.spaceId ? (spaceById.get(meta.spaceId) ?? null) : null;
          const tabName =
            meta.tabId && Array.isArray(space?.tabs)
              ? space.tabs.find((tb) => tb.id === meta.tabId)?.name
              : null;
          const label = tabName || entry.label || entry.where || (meta.pid != null ? `pid ${meta.pid}` : entry.address);
          if (meta.pid != null) roots.push(meta.pid);

          const place = space ? placeOf(space, psList) || entry.cwd || "" : "";
          if (place) {
            places.add(place);
            this.terminalPlaces.set(entry.address, place);
          }

          termRows.push({
            address: entry.address,
            pid: meta.pid,
            space,
            label,
            agent: entry.agent || "",
            folder: entry.cwd || "",
          });
        }

        this.pruneRepoMetadata(places);
        const repoAt = Date.now();
        // Consume due events before lookups so new batches survive the sample.
        this.invalidateRepoWatches(repoAt);
        await Promise.all(Array.from(places, (place) => this.resolveRepo(place, repoAt)));
        if (this.destroyed) return;
        this.syncRepoWatches(cx, places, Date.now());

        const totals = subtreeTotals(procs, roots);
        const stopAt = new Set(roots);
        for (const t of totals.values()) {
          for (const pid of t.pids) stopAt.add(pid);
        }
        const herdr = herdrTotals(procs, commands, stopAt);

        const now = Date.now();
        const snap = buildSnapshot({
          terminals: termRows,
          totals,
          herdr,
          placeOf: (sp) => placeOf(sp, psList),
          repoOf: (place) => this.repoCache.get(place)?.result,
          now,
        });

        for (const proj of snap.projects) {
          for (const wt of proj.worktrees) {
            pushHistory(this.history, wt.key, wt.rss, now);
          }
        }
        pushHistory(this.history, "__herdr__", snap.herdr.rss, now);

        const history = {};
        for (const [k, v] of this.history) {
          if (k !== "__herdr__") history[k] = v.points;
        }
        const herdrHistory = this.history.get("__herdr__")?.points ?? [];

        this.snapshot = { ...snap, history, herdrHistory };
        setShared("orca.resources", this.snapshot);
      } catch {
        // Keep last good snapshot on transient failure.
      } finally {
        this.sampling = false;
        if (!this.destroyed) {
          this.lastSampleAt = Date.now();
          if (this.samplePending) {
            this.samplePending = false;
            this.sample(cx);
          }
          cx.notify();
        }
      }
    });
  }

  render() {
    const t = theme();
    const snap = this.snapshot ?? shared("orca.resources");
    const memText = snap ? fmtMem(snap.rss) : "—";
    const countText = snap ? String(snap.count) : "0";

    return h_flex()
      .id("orca-resources")
      .size_full()
      .items_center()
      .justify_center()
      .px(8)
      .gap(6)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground).bg(t.hover))
      .on_mouse_down("left", (e) => {
        const b = e?.bounds;
        if (!b) {
          openOverlay({
            mod: "orca-resources-panel",
            kind: "popup",
            frame: "none",
            width: 360,
            height: 0.85,
          });
          return;
        }
        const height = Math.max(200, Math.round(b.y - 12));
        openOverlay({
          mod: "orca-resources-panel",
          kind: "popup",
          frame: "none",
          width: 360,
          height,
          at: { x: Math.round(b.x + b.width - 360), y: Math.round(b.y - 4 - height) },
          props: { height },
        });
      })
      .child(svg("mods/orca-resources/chip.svg").size(13).flex_none().text_color(t.muted))
      .child(div().flex_none().child(memText))
      .child(div().flex_none().text_color(t.dim).child("·"))
      .child(div().flex_none().text_color(t.dim).child(">_"))
      .child(div().flex_none().child(countText));
  }
}
