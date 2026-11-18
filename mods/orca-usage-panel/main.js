import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, props, shared, setShared, checking, closeOverlay } from "herdr";
import { LIST_W, DETAILS_W, GAP } from "./layout.js";
import { renderListCard } from "./list.view.js";
import { renderDetailsCard } from "./details.view.js";
import { FONT } from "./ui/tokens.js";

function maxUsed(p) {
  return p.windows?.length ? Math.max(...p.windows.map((w) => w.usedPercent)) : -1;
}

export default class OrcaUsagePanel extends View {
  init(_p, cx) {
    this.icons = {};
    this.owned = false;
    this.hovered = null;
    this.width = LIST_W + GAP + DETAILS_W;
    if (checking() || !props()?.overlay) return;

    // The chip toggles on this: it closes an open panel instead of opening a second one.
    this.owned = true;
    setShared("orca.usage.panel", { id: props().overlay, closedAt: 0 });

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
  }

  async close() {
    if (!this.owned) return;
    setShared("orca.usage.panel", { id: null, closedAt: Date.now() });
  }

  // Hover and click for a provider row. The details card follows the hovered row and goes away with
  // the pointer; row size depends only on the mode, so hover never moves rows.
  rowEvents(id) {
    return {
      onHover: (hovered, cx) => {
        // Entering the next row may be reported before leaving this one, so only clear our own.
        if (hovered && this.hovered !== id) {
          this.hovered = id;
          cx.notify();
        } else if (!hovered && this.hovered === id) {
          this.hovered = null;
          cx.notify();
        }
      },
      onClick: (_e, cx) => {
        if (this.hovered !== id) {
          this.hovered = id;
          cx.notify();
        }
      },
    };
  }

  render() {
    const overlay = props()?.overlay;
    if (!overlay) return div();

    const t = theme();
    const now = Date.now();
    const height = props()?.height ?? 400;
    const data = shared("orca.usage.data") ?? { providers: [], fetchedAt: 0, fetching: false };
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const available = providers
      .filter((p) => p.status !== "unavailable")
      .sort((a, b) => maxUsed(b) - maxUsed(a));
    const unavailable = providers.filter((p) => p.status === "unavailable");
    // Details show only while a row is hovered; with the pointer elsewhere there is just the list.
    const hovered = available.find((p) => p.id === this.hovered) ?? null;

    const side = this.width >= LIST_W + GAP + DETAILS_W;
    const cardHeight = side ? height : Math.floor((height - GAP) / 2);
    const list = renderListCard(this, now, data, available, unavailable, hovered?.id ?? null, cardHeight);
    const details = hovered ? renderDetailsCard(this, now, data, hovered, cardHeight) : null;

    // The root is see-through and fills the popup: a press on it (beside the cards) closes it.
    return div()
      .id("usage-root")
      .w_full()
      .h(height)
      .flex()
      .items_end()
      .text_size(FONT.md)
      .text_color(t.foreground)
      .on_size_change((e, cx) => {
        if (e?.width && Math.round(e.width) !== this.width) {
          this.width = Math.round(e.width);
          cx.notify();
        }
      })
      .on_mouse_down("left", () => closeOverlay(overlay))
      .child(
        side
          ? h_flex().items_end().gap(GAP).child(list).when(details, (el) => el.child(details))
          : v_flex().gap(GAP).when(details, (el) => el.child(details)).child(list),
      );
  }
}
