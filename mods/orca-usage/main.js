import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, knownAgents, exec, openOverlay, shared, setShared, checking } from "herdr";
import config from "./config.js";
import { chipText } from "./format.js";
import { merge } from "./merge.js";

function maxUsed(p) {
  return p.windows?.length ? Math.max(...p.windows.map((w) => w.usedPercent)) : -1;
}

export default class OrcaUsage extends View {
  init(_p, cx) {
    this.providers = [];
    this.fetchedAt = 0;
    this.fetching = false;
    this.stopAsking = false;
    this.manualOnly = false;
    this.lastRefresh = shared("orca.usage.refresh")?.at ?? null;
    this.icons = {};
    this.width = 420;
    let mode = "compact";
    try {
      const saved = localStorage.getItem("usage.mode");
      if (saved === "detailed" || saved === "compact") mode = saved;
    } catch {}
    this.mode = mode;

    if (checking()) return;

    setShared("orca.usage.mode", this.mode);

    cx.spawn(async (cx) => {
      try {
        const agents = await knownAgents({ on: null });
        const icons = {};
        for (const a of agents) {
          const id = a.run?.[0];
          if (id === "claude" || id === "codex" || id === "agy") {
            icons[id] = { icon: a.icon, tint: Boolean(a.tint) };
          }
        }
        this.icons = icons;
      } catch {}
      cx.notify();
    });

    this.fetch(cx);
    cx.timer.every(60000, (cx) => this.tick(cx));
  }

  checkRefresh(cx) {
    const m = shared("orca.usage.mode");
    if ((m === "compact" || m === "detailed") && m !== this.mode) {
      this.mode = m;
      try {
        localStorage.setItem("usage.mode", m);
      } catch {}
    }
    const req = shared("orca.usage.refresh");
    if (req?.at && req.at !== this.lastRefresh) {
      this.lastRefresh = req.at;
      if (req.force) {
        this.manualOnly = false;
        this.fetch(cx);
      } else if (Date.now() - this.fetchedAt >= 5 * 60000) {
        this.fetch(cx);
      }
    }
  }

  tick(cx) {
    if (checking()) return;
    this.checkRefresh(cx);
    if (Date.now() - this.fetchedAt >= 15 * 60000) {
      this.fetch(cx);
    }
  }

  fetch(cx) {
    if (this.fetching) return;
    this.fetching = true;
    setShared("orca.usage.data", {
      providers: this.providers,
      fetchedAt: this.fetchedAt,
      fetching: true,
    });

    cx.spawn(async (cx) => {
      try {
        const skipped = this.stopAsking || this.manualOnly ? ["agy"] : [];
        const args = ["usage", ...skipped.flatMap((id) => ["--skip", id])];
        const res = await exec(config.node, [config.cli, ...args], { timeout: 60000 });
        if (res.code !== 0 && !res.stdout) {
          throw new Error((res.stderr || `exit ${res.code}`).trim());
        }
        const r = JSON.parse((res.stdout || "").trim());
        const next = Array.isArray(r.providers) ? r.providers : [];
        const agy = next.find((p) => p.id === "agy");
        if (agy) {
          if (agy.stopAsking) this.stopAsking = true;
          if (agy.manualOnly) this.manualOnly = true;
          if (agy.status === "ok") this.manualOnly = false;
        }
        this.providers = merge(this.providers, next, skipped);
      } catch {
        this.providers = this.providers.map((p) =>
          p.status === "unavailable"
            ? p
            : { ...p, status: "error", error: p.error || "Couldn't read usage" }
        );
      } finally {
        this.fetchedAt = Date.now();
        this.fetching = false;
        setShared("orca.usage.data", {
          providers: this.providers,
          fetchedAt: this.fetchedAt,
          fetching: false,
        });
        cx.notify();
      }
    });
  }

  render(cx) {
    if (!checking()) this.checkRefresh(cx);
    const t = theme();
    const now = Date.now();
    const stale = this.fetchedAt > 0 && now - this.fetchedAt > 30 * 60000;
    const textColor = stale ? t.dim : t.muted;

    let chips =
      this.providers.length === 0 && this.fetching
        ? ["claude", "codex", "agy"].map((id) => ({ id, windows: [] }))
        : this.providers.filter((p) => p.status !== "unavailable");

    const perChip = this.mode === "detailed" ? 210 : 115;
    const maxChips = Math.max(0, Math.floor((this.width - 80) / perChip));
    if (chips.length > maxChips) {
      const kept = new Set(
        [...chips]
          .sort((a, b) => maxUsed(b) - maxUsed(a))
          .slice(0, maxChips)
          .map((p) => p.id)
      );
      chips = chips.filter((p) => kept.has(p.id));
    }

    return h_flex()
      .id("orca-usage")
      .size_full()
      .items_center()
      .px(10)
      .gap(10)
      .text_size(12)
      .on_size_change((e, cx) => {
        if (e?.width && e.width !== this.width) {
          this.width = e.width;
          cx.notify();
        }
      })
      .child(div().flex_none().text_color(t.dim).child("Used"))
      .child(
        h_flex()
          .items_center()
          .gap(12)
          .cursor_pointer()
          .on_click(() => {
            openOverlay({ mod: "orca-usage-panel", kind: "popup", width: 760, height: 420 });
          })
          .children(
            chips.map((p) => {
              const ic = this.icons[p.id];
              const iconEl = ic?.icon
                ? ic.tint
                  ? svg(ic.icon).size(13).flex_none().text_color(textColor)
                  : image(ic.icon).size(13).flex_none()
                : div().text_color(textColor).child(p.id);
              const maxPct = maxUsed(p);
              return h_flex()
                .items_center()
                .gap(5)
                .flex_none()
                .child(iconEl)
                .when(this.mode === "detailed" && p.windows?.length > 0, (el) =>
                  el.child(
                    div()
                      .w(48)
                      .h(6)
                      .rounded(3)
                      .bg(t.border)
                      .overflow_hidden()
                      .child(
                        div()
                          .h_full()
                          .w(Math.round((48 * Math.min(100, Math.max(0, maxPct))) / 100))
                          .bg(t.muted),
                      ),
                  ),
                )
                .child(div().text_color(textColor).child(chipText(p, this.mode, now)))
                .when(p.status === "error", (el) =>
                  el.child(div().text_color(t.blocked).child("⚠")),
                );
            }),
          ),
      )
      .child(
        div()
          .id("usage-refresh")
          .flex_none()
          .p(2)
          .rounded(4)
          .cursor_pointer()
          .text_color(t.muted)
          .hover((s) => s.text_color(t.foreground).bg(t.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            setShared("orca.usage.refresh", { at: Date.now(), force: true });
          })
          .child(
            this.fetching
              ? svg("mods/orca-usage/refresh.svg").size(13).spin(900)
              : svg("mods/orca-usage/refresh.svg").size(13),
          ),
      );
  }
}
