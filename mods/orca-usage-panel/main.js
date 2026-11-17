import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, props, shared, setShared, checking } from "herdr";
import { until, barColor, windowName, updatedText } from "./format.js";

const DISPLAY_NAMES = {
  claude: "Claude",
  codex: "Codex",
  agy: "Antigravity",
};

function maxUsed(p) {
  return p.windows?.length ? Math.max(...p.windows.map((w) => w.usedPercent)) : -1;
}

function headlineWindow(p) {
  const windows = Array.isArray(p?.windows) ? p.windows : [];
  if (windows.length === 0) return null;
  let top = windows[0];
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].usedPercent > top.usedPercent) top = windows[i];
  }
  return top;
}

function resetLabel(resetsAt, now) {
  if (resetsAt == null) return "";
  const u = until(resetsAt, now);
  if (u === "now") return "Resets now";
  return u ? `Resets in ${u}` : "";
}

export default class OrcaUsagePanel extends View {
  init(_p, cx) {
    this.icons = {};
    this.selected = null;
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

  iconFor(id, color, size = 20) {
    const ic = this.icons[id];
    if (!ic?.icon) return null;
    return ic.tint
      ? svg(ic.icon).size(size).flex_none().text_color(color)
      : image(ic.icon).size(size).flex_none();
  }

  renderLeftPane(t, now, data, available, unavailable, selectedId) {
    const mode = shared("orca.usage.mode") ?? "compact";

    return v_flex()
      .w(360)
      .flex_none()
      .h_full()
      .border_r(1)
      .border_color(t.border)
      .child(
        v_flex()
          .w_full()
          .p(12)
          .gap(10)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .child(
                h_flex()
                  .items_center()
                  .gap(6)
                  .child(div().text_size(13).font_bold().text_color(t.foreground).child("Usage"))
                  .child(div().text_size(12).text_color(t.muted).child("all agents"))
              )
              .child(
                div()
                  .id("usage-refresh")
                  .p(4)
                  .rounded(4)
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover((s) => s.text_color(t.foreground).bg(t.selected))
                  .on_click(() => {
                    if (!data.fetching) {
                      setShared("orca.usage.refresh", { at: Date.now(), force: true });
                    }
                  })
                  .child(
                    data.fetching
                      ? svg("mods/orca-usage/refresh.svg").size(13).spin(900)
                      : svg("mods/orca-usage/refresh.svg").size(13)
                  )
              )
          )
          .child(
            h_flex()
              .w_full()
              .p(2)
              .gap(2)
              .rounded(6)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .children(
                [
                  { id: "detailed", label: "Detailed" },
                  { id: "compact", label: "Compact" },
                ].map((seg) => {
                  const active = mode === seg.id;
                  return div()
                    .id(`mode-${seg.id}`)
                    .flex_1()
                    .py(4)
                    .rounded(4)
                    .text_center()
                    .text_size(11)
                    .cursor_pointer()
                    .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
                    .when(!active, (el) =>
                      el.text_color(t.muted).hover((s) => s.text_color(t.foreground))
                    )
                    .on_click((_e, cx) => {
                      setShared("orca.usage.mode", seg.id);
                      cx.notify();
                    })
                    .child(seg.label);
                })
              )
          )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(4)
          .children(
            available.map((p) => {
              const name = DISPLAY_NAMES[p.id] ?? p.id;
              const iconEl = this.iconFor(p.id, t.foreground, 20);
              const isSelected = p.id === selectedId;
              const topWin = headlineWindow(p);
              const pct = topWin ? Math.max(0, Math.min(100, Math.round(topWin.usedPercent))) : null;
              const resetText = topWin ? until(topWin.resetsAt, now) : "";
              const subLabel = p.id === "agy" && topWin?.label ? topWin.label : null;

              return h_flex()
                .id(`provider-${p.id}`)
                .w_full()
                .h(48)
                .px(12)
                .gap(10)
                .items_center()
                .justify_between()
                .cursor_pointer()
                .when(isSelected, (el) => el.bg(t.selected))
                .when(!isSelected, (el) => el.hover((s) => s.bg(t.selected)))
                .on_mouse_move((_e, cx) => {
                  if (this.selected !== p.id) {
                    this.selected = p.id;
                    cx.notify();
                  }
                })
                .on_click((_e, cx) => {
                  if (this.selected !== p.id) {
                    this.selected = p.id;
                    cx.notify();
                  }
                })
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .items_center()
                    .gap(10)
                    .when(Boolean(iconEl), (el) => el.child(iconEl))
                    .child(
                      v_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(1)
                        .child(
                          div()
                            .text_size(12)
                            .text_color(t.foreground)
                            .truncate()
                            .child(name)
                        )
                        .when(Boolean(subLabel), (el) =>
                          el.child(
                            div()
                              .text_size(11)
                              .text_color(t.dim)
                              .truncate()
                              .child(subLabel)
                          )
                        )
                    )
                )
                .child(
                  h_flex()
                    .flex_none()
                    .items_center()
                    .gap(6)
                    .when(Boolean(topWin && resetText), (el) =>
                      el.child(div().text_size(11).text_color(t.muted).child(resetText))
                    )
                    .when(p.status === "error", (el) =>
                      el.child(div().text_size(12).text_color(t.blocked).child("⚠"))
                    )
                    .when(topWin !== null, (el) =>
                      el.child(div().text_size(12).text_color(t.foreground).child(`${pct}%`))
                    )
                    .when(topWin === null && p.status !== "error", (el) =>
                      el.child(div().text_size(12).text_color(t.muted).child("--"))
                    )
                    .child(div().text_size(13).text_color(t.dim).child("›"))
                );
            })
          )
          .when(unavailable.length > 0, (el) =>
            el.child(
              v_flex()
                .w_full()
                .mt(4)
                .pt(4)
                .border_t(1)
                .border_color(t.border)
                .children(
                  unavailable.map((p) => {
                    const name = DISPLAY_NAMES[p.id] ?? p.id;
                    const iconEl = this.iconFor(p.id, t.dim, 20);
                    return h_flex()
                      .w_full()
                      .h(48)
                      .px(12)
                      .gap(10)
                      .items_center()
                      .text_color(t.dim)
                      .when(Boolean(iconEl), (el) => el.child(iconEl))
                      .child(
                        v_flex()
                          .flex_1()
                          .min_w(0)
                          .gap(1)
                          .child(div().text_size(12).text_color(t.dim).truncate().child(name))
                          .child(
                            div()
                              .text_size(11)
                              .text_color(t.dim)
                              .truncate()
                              .child(p.error || "Unavailable")
                          )
                      );
                  })
                )
            )
          )
      );
  }

  renderRightPane(t, now, data, p) {
    if (!p) {
      return v_flex()
        .flex_1()
        .h_full()
        .items_center()
        .justify_center()
        .child(div().text_size(12).text_color(t.muted).child("No usage data"));
    }

    const name = DISPLAY_NAMES[p.id] ?? p.id;
    const iconEl = this.iconFor(p.id, t.foreground, 20);
    const windows = Array.isArray(p.windows) ? p.windows : [];

    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .p(16)
      .gap(12)
      .overflow_y_scrollbar()
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .gap(8)
          .child(
            h_flex()
              .items_center()
              .gap(8)
              .when(Boolean(iconEl), (el) => el.child(iconEl))
              .child(
                div()
                  .text_size(14)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child(name)
              )
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .child(updatedText(data.fetchedAt, now))
          )
      )
      .when(p.status === "error" && Boolean(p.error), (el) =>
        el.child(div().text_size(11).text_color(t.blocked).child(p.error))
      )
      .child(
        v_flex()
          .w_full()
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .rounded(10)
          .p(14)
          .gap(12)
          .child(
            div()
              .text_size(12)
              .font_semibold()
              .text_color(t.foreground)
              .child("Default account")
          )
          .when(p.status === "ok" && windows.length === 0, (el) =>
            el.child(div().text_size(12).text_color(t.muted).child("No limits reported"))
          )
          .children(
            windows.map((w) => {
              const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
              const resetStr = resetLabel(w.resetsAt, now);

              return v_flex()
                .w_full()
                .gap(6)
                .child(div().text_size(12).text_color(t.foreground).child(windowName(w)))
                .child(
                  h_flex()
                    .w_full()
                    .h(6)
                    .rounded(3)
                    .bg(t.border)
                    .overflow_hidden()
                    .when(pct > 0, (el) =>
                      el.child(
                        div()
                          .h_full()
                          .flex_basis(0)
                          .flex_grow(pct)
                          .rounded(3)
                          .bg(t[barColor(pct)])
                      )
                    )
                    .when(pct < 100, (el) =>
                      el.child(div().h_full().flex_basis(0).flex_grow(100 - pct))
                    )
                )
                .child(
                  h_flex()
                    .w_full()
                    .justify_between()
                    .text_size(11)
                    .text_color(t.muted)
                    .child(div().child(`${pct}% used`))
                    .when(Boolean(resetStr), (el) => el.child(div().child(resetStr)))
                );
            })
          )
      );
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

    const selectedProvider =
      available.find((p) => p.id === this.selected) ?? available[0] ?? null;

    return h_flex()
      .size_full()
      .bg(t.popover)
      .text_size(12)
      .text_color(t.foreground)
      .child(
        this.renderLeftPane(
          t,
          now,
          data,
          available,
          unavailable,
          selectedProvider?.id ?? null
        )
      )
      .child(this.renderRightPane(t, now, data, selectedProvider));
  }
}
