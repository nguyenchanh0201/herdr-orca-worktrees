import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props, shared, setShared, checking, closeOverlay, exec } from "herdr";
import { renderSparkline, renderHeader, renderSortHeader, renderConfirmAndErrors } from "./header.view.js";
import { renderResourcesTab } from "./resources.view.js";
import { renderPtysTab } from "./ptys.view.js";

const CARD_W = 360;
const SHELLS = new Set(["zsh", "bash", "fish", "sh"]);
const AGENT_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  agy: "Antigravity",
};

function isAgentName(agent) {
  return Boolean(agent) && !SHELLS.has(String(agent).toLowerCase());
}

function agentDisplayName(agent) {
  const key = String(agent || "").toLowerCase();
  return AGENT_NAMES[key] ?? agent;
}

function compareItems(a, b, sort) {
  const mul = sort.dir === "asc" ? 1 : -1;
  if (sort.by === "name") {
    const na = String(a.name ?? a.label ?? "").toLowerCase();
    const nb = String(b.name ?? b.label ?? "").toLowerCase();
    return na.localeCompare(nb) * mul;
  }
  const va = sort.by === "cpu" ? (a.cpu ?? 0) : (a.rss ?? 0);
  const vb = sort.by === "cpu" ? (b.cpu ?? 0) : (b.rss ?? 0);
  return (va - vb) * mul;
}

export default class OrcaResourcesPanel extends View {
  init(_p, _cx) {
    let tab = "resources";
    try {
      const savedTab = localStorage.getItem("resources.tab");
      if (savedTab === "resources" || savedTab === "ptys") tab = savedTab;
    } catch {}
    this.tab = tab;

    let folded = new Set(["herdr"]);
    try {
      const raw = localStorage.getItem("resources.folded");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) folded = new Set(parsed);
      }
    } catch {}
    this.folded = folded;

    this.sort = { by: "mem", dir: "desc" };
    this.orderCache = new Map();
    this.detailsOpen = false;
    this.selected = new Set();
    this.confirming = null;
    this.ending = false;
    this.endErrors = [];
    this.unfoldedPtys = new Set();
    this.ptyDetails = new Map();

    if (checking() || !props()?.overlay) return;
    setShared("orca.resources.open", true);
  }

  destroy() {
    setShared("orca.resources.open", false);
  }

  close(overlay) {
    setShared("orca.resources.open", false);
    closeOverlay(overlay);
  }

  setTab(tab, cx) {
    this.tab = tab;
    try {
      localStorage.setItem("resources.tab", tab);
    } catch {}
    cx.notify();
  }

  toggleFold(key, cx) {
    if (this.folded.has(key)) this.folded.delete(key);
    else this.folded.add(key);
    try {
      localStorage.setItem("resources.folded", JSON.stringify(Array.from(this.folded)));
    } catch {}
    cx.notify();
  }

  toggleSort(by, cx) {
    if (this.sort.by === by) {
      this.sort = { by, dir: this.sort.dir === "desc" ? "asc" : "desc" };
    } else {
      this.sort = { by, dir: by === "name" ? "asc" : "desc" };
    }
    this.orderCache.clear();
    cx.notify();
  }

  sortStable(items, keyFn, scopeKey) {
    const list = [...(items ?? [])];
    const cached = this.orderCache.get(scopeKey);
    if (cached) {
      return list.sort((a, b) => {
        const ia = cached.get(keyFn(a)) ?? Infinity;
        const ib = cached.get(keyFn(b)) ?? Infinity;
        if (ia !== ib) return ia - ib;
        return compareItems(a, b, this.sort);
      });
    }
    list.sort((a, b) => compareItems(a, b, this.sort));
    if (list.length > 0) {
      const idxMap = new Map();
      for (let i = 0; i < list.length; i++) idxMap.set(keyFn(list[i]), i);
      this.orderCache.set(scopeKey, idxMap);
    }
    return list;
  }

  renderSparkline(t, points) { return renderSparkline(this, t, points); }

  renderHeader(t, snap) { return renderHeader(this, t, snap); }

  renderSortHeader(t) { return renderSortHeader(this, t); }

  renderConfirmAndErrors(t, snap) { return renderConfirmAndErrors(this, t, snap); }

  renderResourcesTab(t, snap) { return renderResourcesTab(this, t, snap); }

  allHerdrRows(snap) {
    const rows = [];
    for (const proj of snap?.projects ?? []) {
      for (const wt of proj.worktrees ?? []) {
        for (const row of wt.terminals ?? []) rows.push(row);
      }
    }
    return rows;
  }

  confirmMessage(addresses, snap) {
    const rows = this.allHerdrRows(snap);
    const byAddr = new Map(rows.map((r) => [r.address, r]));
    const n = addresses.length;
    const base = `End ${n} ${n === 1 ? "terminal" : "terminals"} and their processes?`;
    const runningAgent = addresses
      .map((a) => byAddr.get(a)?.agent)
      .find((ag) => isAgentName(ag));
    return runningAgent ? `${base} One is running ${agentDisplayName(runningAgent)}.` : base;
  }

  togglePtyDetails(address, cx) {
    if (this.unfoldedPtys.has(address)) {
      this.unfoldedPtys.delete(address);
      cx.notify();
      return;
    }
    this.unfoldedPtys.add(address);
    cx.notify();
    if (this.ptyDetails.has(address)) return;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("hc", ["get", address, "--json"], { timeout: 5000 });
        if (res.code === 0 && res.stdout) {
          this.ptyDetails.set(address, JSON.parse(res.stdout));
        }
      } catch {}
      cx.notify();
    });
  }

  endTerminals(addresses, snap, cx) {
    if (this.ending || !addresses.length) return;
    const rows = this.allHerdrRows(snap);
    const labelOf = new Map(rows.map((r) => [r.address, r.label]));
    this.ending = true;
    this.endErrors = [];
    cx.notify();

    cx.spawn(async (cx) => {
      const queue = [...addresses];
      const errors = [];
      const workerCount = Math.min(4, queue.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const addr = queue.shift();
          try {
            const res = await exec("hc", ["kill", addr], { timeout: 5000 });
            if (res.code !== 0) {
              const msg = (res.stderr || `exit ${res.code}`).trim();
              errors.push(`${labelOf.get(addr) || addr}: ${msg}`);
            }
          } catch (err) {
            errors.push(`${labelOf.get(addr) || addr}: ${err?.message || "failed"}`);
          }
        }
      });
      await Promise.all(workers);

      this.selected.clear();
      this.confirming = null;
      this.ending = false;
      this.endErrors = errors;
      setShared("orca.resources.refresh", { at: Date.now() });
      cx.notify();
    });
  }

  renderPtysTab(t, snap) { return renderPtysTab(this, t, snap); }

  render() {
    const overlay = props()?.overlay;
    if (!overlay) return div();

    const t = theme();
    const height = props()?.height ?? 400;
    const snap = shared("orca.resources") ?? null;

    const card = v_flex()
      .w(CARD_W)
      .flex_none()
      .max_h(height)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.renderHeader(t, snap))
      .child(
        this.tab === "ptys"
          ? this.renderPtysTab(t, snap)
          : this.renderResourcesTab(t, snap),
      );

    return div()
      .id("resources-root")
      .w_full()
      .h(height)
      .flex()
      .items_end()
      .text_size(12)
      .text_color(t.foreground)
      .on_mouse_down("left", () => this.close(overlay))
      .child(card);
  }
}
