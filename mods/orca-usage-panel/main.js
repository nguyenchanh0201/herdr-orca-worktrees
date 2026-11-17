import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, props, shared, setShared, checking } from "herdr";
import { until, barColor } from "./format.js";

const DISPLAY_NAMES = {
  claude: "Claude",
  codex: "Codex",
  agy: "Antigravity",
};

function maxUsed(p) {
  return p.windows?.length ? Math.max(...p.windows.map((w) => w.usedPercent)) : -1;
}

function windowLabel(w, now) {
  if (w.minutes > 0) {
    const u = until(w.resetsAt, now);
    if (u === "now") return `${w.label} · resets now`;
    if (u) return `${w.label} · resets in ${u}`;
  }
  return w.label;
}

export default class OrcaUsagePanel extends View {
  init(_p, cx) {
    this.icons = {};
    if (checking() || !props()?.overlay) return;

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

  iconFor(id, color) {
    const ic = this.icons[id];
    if (!ic?.icon) return null;
    return ic.tint
      ? svg(ic.icon).size(13).flex_none().text_color(color)
      : image(ic.icon).size(13).flex_none();
  }

  render() {
    if (!props()?.overlay) return div();

    const t = theme();
    const now = Date.now();
    const data = shared("orca.usage.data") ?? { providers: [], fetchedAt: 0, fetching: false };
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const available = providers
      .filter((p) => p.status !== "unavailable")
      .sort((a, b) => maxUsed(b) - maxUsed(a));
    const unavailable = providers.filter((p) => p.status === "unavailable");

    const checkedText =
      data.fetchedAt > 0
        ? `checked ${Math.max(0, Math.floor((now - data.fetchedAt) / 60000))}m ago`
        : "checking…";

    return v_flex()
      .w_full()
      .h_full()
      .bg(t.popover)
      .p(12)
      .gap(10)
      .text_size(12)
      .text_color(t.foreground)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .pb(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            v_flex()
              .gap(2)
              .child(div().text_size(13).text_color(t.foreground).child("Usage · all agents"))
              .child(div().text_size(11).text_color(t.dim).child(checkedText))
          )
          .child(
            div()
              .id("usage-refresh")
              .px(8)
              .py(4)
              .rounded(5)
              .cursor_pointer()
              .text_color(t.muted)
              .hover((s) => s.bg(t.selected))
              .on_click(() => {
                if (!data.fetching) {
                  setShared("orca.usage.refresh", { at: Date.now(), force: true });
                }
              })
              .child(data.fetching ? "···" : "↻")
          )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(12)
          .children(
            available.map((p) => {
              const name = DISPLAY_NAMES[p.id] ?? p.id;
              const iconEl = this.iconFor(p.id, t.foreground);
              const windows = Array.isArray(p.windows) ? p.windows : [];
              return v_flex()
                .w_full()
                .gap(6)
                .child(
                  h_flex()
                    .items_center()
                    .gap(6)
                    .when(Boolean(iconEl), (el) => el.child(iconEl))
                    .child(div().text_color(t.foreground).child(name))
                )
                .when(p.status === "error" && Boolean(p.error), (el) =>
                  el.child(div().text_size(11).text_color(t.blocked).child(p.error))
                )
                .when(p.status === "ok" && windows.length === 0, (el) =>
                  el.child(div().text_size(11).text_color(t.dim).child("No limits reported"))
                )
                .children(
                  windows.map((w) => {
                    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
                    return v_flex()
                      .w_full()
                      .gap(3)
                      .child(
                        h_flex()
                          .w_full()
                          .justify_between()
                          .text_size(11)
                          .child(div().text_color(t.muted).child(windowLabel(w, now)))
                          .child(div().text_color(t.foreground).child(`${pct}%`))
                      )
                      .child(
                        h_flex()
                          .w_full()
                          .h(5)
                          .rounded(2.5)
                          .bg(t.border)
                          .overflow_hidden()
                          .when(pct > 0, (el) =>
                            el.child(
                              div()
                                .h_full()
                                .flex_basis(0)
                                .flex_grow(pct)
                                .bg(t[barColor(pct)])
                            )
                          )
                          .when(pct < 100, (el) =>
                            el.child(div().h_full().flex_basis(0).flex_grow(100 - pct))
                          )
                      );
                  })
                );
            })
          )
          .when(unavailable.length > 0, (el) =>
            el.child(
              v_flex()
                .w_full()
                .pt(6)
                .gap(4)
                .border_t(1)
                .border_color(t.border)
                .children(
                  unavailable.map((p) => {
                    const name = DISPLAY_NAMES[p.id] ?? p.id;
                    const iconEl = this.iconFor(p.id, t.dim);
                    return h_flex()
                      .w_full()
                      .justify_between()
                      .items_center()
                      .text_size(11)
                      .text_color(t.dim)
                      .child(
                        h_flex()
                          .items_center()
                          .gap(6)
                          .when(Boolean(iconEl), (el) => el.child(iconEl))
                          .child(name)
                      )
                      .child(div().child(p.error || "Unavailable"));
                  })
                )
            )
          )
      );
  }
}
