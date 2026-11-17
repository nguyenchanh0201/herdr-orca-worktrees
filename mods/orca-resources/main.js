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
} from "herdr";
import config from "./config.js";
import {
  parsePs,
  subtreeTotals,
  herdrTotals,
  buildSnapshot,
  pushHistory,
  fmtMem,
} from "./tree.js";
import { placeOf } from "./place.js";

function baseName(p) {
  if (!p) return "";
  const trimmed = String(p).replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
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

export default class OrcaResources extends View {
  init(_p, cx) {
    this.snapshot = shared("orca.resources") ?? null;
    this.sampling = false;
    this.lastSampleAt = 0;
    this.lastRefresh = shared("orca.resources.refresh")?.at ?? null;
    this.termCache = new Map();
    this.repoCache = new Map();
    this.history = new Map();

    if (checking()) return;

    this.sample(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
  }

  checkRefresh(cx) {
    const req = shared("orca.resources.refresh");
    if (req?.at && req.at !== this.lastRefresh) {
      this.lastRefresh = req.at;
      this.sample(cx);
      return true;
    }
    return false;
  }

  tick(cx) {
    if (checking()) return;
    if (this.checkRefresh(cx)) return;
    const interval = shared("orca.resources.open") ? 2000 : 5000;
    if (Date.now() - this.lastSampleAt >= interval) {
      this.sample(cx);
    }
  }

  async resolveRepo(place) {
    if (!place) return { key: "", name: "" };
    if (this.repoCache.has(place)) return this.repoCache.get(place);
    let result = { key: place, name: baseName(place) || place };
    try {
      const res = await exec(config.node, [config.cli, "info", place], { timeout: 10000 });
      const parsed = JSON.parse((res.stdout || "").trim() || "{}");
      if (parsed && typeof parsed.primary === "string" && parsed.primary && !parsed.error) {
        result = { key: parsed.primary, name: baseName(parsed.primary) || parsed.primary };
      }
    } catch {}
    this.repoCache.set(place, result);
    return result;
  }

  async resolveTerminalMeta(entry, herdrTerms) {
    const addr = entry.address;
    const fromHerdr = herdrTerms.find((x) => x.address === addr);
    const hasLabels = entry.labels && typeof entry.labels === "object";
    const directPid = entry.pid ?? fromHerdr?.pid ?? null;

    if (hasLabels && directPid != null) {
      return {
        pid: directPid,
        spaceId: entry.labels["herdr.space"] ?? null,
        tabId: entry.labels["herdr.tab"] ?? null,
      };
    }

    if (this.termCache.has(addr)) {
      const cached = this.termCache.get(addr);
      return {
        pid: directPid ?? cached.pid,
        spaceId: hasLabels ? (entry.labels["herdr.space"] ?? null) : cached.spaceId,
        tabId: hasLabels ? (entry.labels["herdr.tab"] ?? null) : cached.tabId,
      };
    }

    let meta = { pid: directPid, spaceId: null, tabId: null };
    try {
      const res = await exec("hc", ["get", addr, "--json"], { timeout: 5000 });
      if (res.code === 0 && res.stdout) {
        const info = JSON.parse(res.stdout);
        meta = {
          pid: directPid ?? info.pid ?? null,
          spaceId: info.labels?.["herdr.space"] ?? null,
          tabId: info.labels?.["herdr.tab"] ?? null,
        };
      }
    } catch {}
    this.termCache.set(addr, meta);
    return meta;
  }

  sample(cx) {
    if (this.sampling) return;
    this.sampling = true;

    cx.spawn(async (cx) => {
      try {
        const [psRes, commRes, hcRes] = await Promise.all([
          exec("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { timeout: 10000 }),
          exec("ps", ["-axo", "pid=,comm="], { timeout: 10000 }),
          exec("hc", ["ls", "--json"], { timeout: 5000 }),
        ]);

        const procs = parsePs(psRes?.stdout ?? "");
        const commands = parseCommands(commRes?.stdout ?? "");
        let hcEntries = [];
        try {
          const parsed = JSON.parse((hcRes?.stdout || "").trim() || "{}");
          if (Array.isArray(parsed.terminals)) hcEntries = parsed.terminals;
        } catch {}

        const liveEntries = hcEntries.filter(
          (e) => e && e.state === "live" && typeof e.address === "string" && !e.address.includes("/"),
        );

        const sps = spaces();
        const psList = panes();
        const herdrTerms = typeof terminals === "function" ? terminals() : [];
        const spaceById = new Map(sps.map((s) => [s.id, s]));

        const metas = await Promise.all(
          liveEntries.map((e) => this.resolveTerminalMeta(e, herdrTerms)),
        );

        const termRows = [];
        const places = new Set();
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
          if (place) places.add(place);

          termRows.push({
            address: entry.address,
            pid: meta.pid,
            space,
            label,
            agent: entry.agent || "",
            folder: entry.cwd || "",
          });
        }

        await Promise.all(Array.from(places).map((p) => this.resolveRepo(p)));

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
          repoOf: (place) => this.repoCache.get(place) ?? { key: place, name: baseName(place) || place },
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
        this.lastSampleAt = Date.now();
        cx.notify();
      }
    });
  }

  render(cx) {
    if (!checking()) this.checkRefresh(cx);
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
