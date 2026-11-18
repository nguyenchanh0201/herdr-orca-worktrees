import { View } from "gpui-kit";
import { h_flex } from "gpui-base";
import { knownAgents, exec, openOverlay, closeOverlay, shared, setShared, checking } from "herdr";
import { SPACE, FONT } from "./ui/tokens.js";
import { text } from "./ui/atoms/text.js";
import { icon } from "./ui/atoms/icon.js";
import { progressBar } from "./ui/atoms/progress-bar.js";
import { iconButton } from "./ui/molecules/icon-button.js";
import config from "./config.js";
import { chipText } from "./format.js";
import { merge } from "./merge.js";

// Both cards of orca-usage-panel side by side: LIST_W + GAP + DETAILS_W there.
const PANEL_W = 648;
// A press this soon after the panel closed is the click that closed it, not a request to reopen.
const PANEL_REOPEN_GUARD_MS = 300;
// The panel is as tall as the room above the strip minus PANEL_TOP_MARGIN (never under PANEL_MIN_H),
// and ends PANEL_GAP_ABOVE_STRIP above the strip.
const PANEL_MIN_H = 200;
const PANEL_TOP_MARGIN = 12;
const PANEL_GAP_ABOVE_STRIP = 4;
// Usage older than this is drawn dim.
const STALE_AFTER_MS = 30 * 60000;
// Room one chip needs in the strip, compact and detailed, and what the strip keeps for "Used" and
// the refresh button; chips beyond what fits are dropped, least used first.
const CHIP_W_COMPACT = 115;
const CHIP_W_DETAILED = 210;
const STRIP_RESERVED_W = 80;
const CHIP_BAR_W = 48;
const REFRESH_ICON = "orca-icons/refresh.svg";

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
    // A panel id left over from a previous run would make the first press try to close a dead overlay.
    setShared("orca.usage.panel", null);

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

  // One provider in the strip: icon, a mini bar when detailed, the headline text, a warning on error.
  renderChip(p, now, tone) {
    const ic = this.icons[p.id];
    const iconEl = ic?.icon
      ? icon(ic.icon, { size: "sm", tone, tint: Boolean(ic.tint) })
      : text(p.id, { tone });
    const pct = Math.min(100, Math.max(0, maxUsed(p)));
    return h_flex()
      .items_center()
      .gap(SPACE.sm)
      .flex_none()
      .child(iconEl)
      .when(this.mode === "detailed" && p.windows?.length > 0, (el) =>
        el.child(progressBar(pct, { tone: "muted", width: CHIP_BAR_W })),
      )
      .child(text(chipText(p, this.mode, now), { tone }))
      .when(p.status === "error", (el) => el.child(text("⚠", { tone: "blocked" })));
  }

  render(cx) {
    if (!checking()) this.checkRefresh(cx);
    const now = Date.now();
    const stale = this.fetchedAt > 0 && now - this.fetchedAt > STALE_AFTER_MS;
    const tone = stale ? "dim" : "muted";

    let chips =
      this.providers.length === 0 && this.fetching
        ? ["claude", "codex", "agy"].map((id) => ({ id, windows: [] }))
        : this.providers.filter((p) => p.status !== "unavailable");

    const perChip = this.mode === "detailed" ? CHIP_W_DETAILED : CHIP_W_COMPACT;
    const maxChips = Math.max(0, Math.floor((this.width - STRIP_RESERVED_W) / perChip));
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
      .px(SPACE.lg)
      .gap(SPACE.lg)
      .text_size(FONT.md)
      .on_size_change((e, cx) => {
        if (e?.width && e.width !== this.width) {
          this.width = e.width;
          cx.notify();
        }
      })
      // A popup at {x, y} is placed by its top-left corner, kept inside the window and as tall as its
      // content (capped at height), so the panel gets an exact height that ends just above the strip.
      // Its width is exactly the two cards, so it sits over the chip instead of spanning the window.
      .on_mouse_down("left", (e) => {
        // Toggle: a press while the panel is open closes it. A press that just dismissed it (the
        // outside-click close may land before this handler) must not reopen it either.
        const panel = shared("orca.usage.panel");
        if (panel?.id) {
          try {
            closeOverlay(panel.id);
          } catch {}
          setShared("orca.usage.panel", { id: null, closedAt: Date.now() });
          return;
        }
        if (panel?.closedAt && Date.now() - panel.closedAt < PANEL_REOPEN_GUARD_MS) return;
        const b = e?.bounds;
        if (!b) {
          openOverlay({ mod: "orca-usage-panel", kind: "popup", frame: "none", width: PANEL_W, height: 0.85 });
          return;
        }
        const height = Math.max(PANEL_MIN_H, Math.round(b.y - PANEL_TOP_MARGIN));
        openOverlay({
          mod: "orca-usage-panel",
          kind: "popup",
          frame: "none",
          width: PANEL_W,
          height,
          at: { x: Math.round(b.x), y: Math.round(b.y - PANEL_GAP_ABOVE_STRIP - height) },
          props: { height },
        });
      })
      .child(text("Used", { tone: "dim" }).flex_none())
      .child(
        h_flex()
          .items_center()
          .gap(SPACE.xl)
          .cursor_pointer()
          .children(chips.map((p) => this.renderChip(p, now, tone))),
      )
      .child(
        iconButton({
          id: "usage-refresh",
          src: REFRESH_ICON,
          busy: this.fetching,
          pad: "2xs",
          hoverBg: "hover",
          isolated: true,
          onClick: () => setShared("orca.usage.refresh", { at: Date.now(), force: true }),
        }),
      );
  }
}
