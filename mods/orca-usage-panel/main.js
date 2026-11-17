import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, props, shared, setShared, checking, closeOverlay } from "herdr";
import { until, barColor, windowName, updatedText, detailLines } from "./format.js";

const LIST_W = 340;
const DETAILS_W = 300;
const GAP = 8;

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
    this.width = LIST_W + GAP + DETAILS_W;
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

  bar(t, pct, width) {
    const track = h_flex().h(6).rounded(3).bg(t.border).overflow_hidden();
    return (width ? track.w(width).flex_none() : track.w_full())
      .when(pct > 0, (el) =>
        el.child(div().h_full().flex_basis(0).flex_grow(pct).rounded(3).bg(t[barColor(pct)]))
      )
      .when(pct < 100, (el) => el.child(div().h_full().flex_basis(0).flex_grow(100 - pct)));
  }

  card(t, width, maxH) {
    return v_flex()
      .w(width)
      .flex_none()
      .max_h(maxH)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      // A press on a card must not reach the root, which closes the popup.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  }

  renderHeader(t, data, mode) {
    return v_flex()
      .w_full()
      .flex_none()
      .p(12)
      .gap(10)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .child(div().text_size(13).font_bold().text_color(t.foreground).child("Usage"))
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(div().text_size(12).text_color(t.muted).child("all agents"))
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
                .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
                .on_click((_e, cx) => {
                  setShared("orca.usage.mode", seg.id);
                  cx.notify();
                })
                .child(seg.label);
            })
          )
      );
  }

  // Selection follows hover entry; row size depends only on the mode, so hover never moves rows.
  selectable(row, p, isSelected, t) {
    return row
      .id(`provider-${p.id}`)
      .cursor_pointer()
      .when(isSelected, (el) => el.bg(t.selected))
      .when(!isSelected, (el) => el.hover((s) => s.bg(t.selected)))
      .on_hover((hovered, cx) => {
        if (hovered && this.selected !== p.id) {
          this.selected = p.id;
          cx.notify();
        }
      })
      .on_click((_e, cx) => {
        if (this.selected !== p.id) {
          this.selected = p.id;
          cx.notify();
        }
      });
  }

  // "--" with no windows, "⚠" on error, or null when the row has numbers to show.
  emptyMark(t, p) {
    if (p.status === "error") return div().text_size(12).text_color(t.blocked).child("⚠");
    if (!p.windows?.length) return div().text_size(12).text_color(t.muted).child("--");
    return null;
  }

  renderCompactRow(t, now, p, isSelected) {
    const name = DISPLAY_NAMES[p.id] ?? p.id;
    const iconEl = this.iconFor(p.id, t.foreground, 20);
    const topWin = headlineWindow(p);
    const pct = topWin ? Math.max(0, Math.min(100, Math.round(topWin.usedPercent))) : null;
    const resetText = topWin ? until(topWin.resetsAt, now) : "";
    const subLabel = p.id === "agy" && topWin?.label ? topWin.label : null;

    return this.selectable(
      h_flex().w_full().h(48).px(12).gap(10).items_center().justify_between(),
      p,
      isSelected,
      t
    )
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
              .child(div().text_size(12).text_color(t.foreground).truncate().child(name))
              .when(Boolean(subLabel), (el) =>
                el.child(div().text_size(11).text_color(t.dim).truncate().child(subLabel))
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
  }

  renderDetailedRow(t, now, p, isSelected) {
    const name = DISPLAY_NAMES[p.id] ?? p.id;
    const iconEl = this.iconFor(p.id, t.foreground, 20);
    const resetStr = resetLabel(headlineWindow(p)?.resetsAt, now);
    const mark = this.emptyMark(t, p);
    const lines = detailLines(p);

    return this.selectable(
      h_flex().w_full().px(12).py(8).gap(8).items_center(),
      p,
      isSelected,
      t
    )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(4)
          .child(
            h_flex()
              .w_full()
              .items_center()
              .gap(10)
              .child(iconEl ?? div().w(20).flex_none())
              .child(div().flex_none().text_size(13).text_color(t.foreground).child(name))
              .when(Boolean(resetStr), (el) =>
                el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(resetStr))
              )
          )
          .when(Boolean(mark), (el) => el.child(h_flex().pl(30).child(mark)))
          .children(
            lines.map((line) =>
              h_flex()
                .w_full()
                .pl(30)
                .gap(10)
                .items_center()
                .children(
                  line.map((it) => {
                    const color = barColor(it.pct);
                    // A lone item (Antigravity) gives its long label the spare room, so bars line up.
                    const lone = line.length === 1;
                    return h_flex()
                      .min_w(0)
                      .when(lone, (el) => el.flex_1())
                      .items_center()
                      .gap(6)
                      .child(
                        div()
                          .text_size(11)
                          .text_color(t.muted)
                          .when(lone, (el) => el.flex_1().min_w(0).truncate())
                          .when(!lone, (el) => el.flex_none())
                          .child(it.label)
                      )
                      .child(this.bar(t, it.pct, 28))
                      .child(
                        div()
                          .flex_none()
                          .w(30)
                          .text_size(11)
                          .text_color(color === "muted" ? t.foreground : t[color])
                          .child(`${it.pct}%`)
                      );
                  })
                )
            )
          )
      )
      .child(div().flex_none().text_size(13).text_color(t.dim).child("›"));
  }

  renderListCard(t, now, data, available, unavailable, selectedId, maxH) {
    const mode = shared("orca.usage.mode") ?? "compact";
    return this.card(t, LIST_W, maxH)
      .child(this.renderHeader(t, data, mode))
      .child(
        v_flex()
          .w_full()
          .id("usage-list")
          .flex_shrink(1)
          .min_h(0)
          // overflow_y_scrollbar collapses to zero in a content-sized card; the plain scroll doesn't.
          .overflow_y_scroll()
          .py(4)
          .children(
            available.map((p) =>
              mode === "detailed"
                ? this.renderDetailedRow(t, now, p, p.id === selectedId)
                : this.renderCompactRow(t, now, p, p.id === selectedId)
            )
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
                            div().text_size(11).text_color(t.dim).truncate().child(p.error || "Unavailable")
                          )
                      );
                  })
                )
            )
          )
      );
  }

  renderDetailsCard(t, now, data, p, maxH) {
    const card = this.card(t, DETAILS_W, maxH);
    if (!p) {
      return card
        .p(14)
        .child(div().text_size(12).text_color(t.muted).child("No usage data"));
    }

    const name = DISPLAY_NAMES[p.id] ?? p.id;
    const iconEl = this.iconFor(p.id, t.foreground, 20);
    const windows = Array.isArray(p.windows) ? p.windows : [];

    return card.child(
      v_flex()
        .w_full()
        .id("usage-details")
        .flex_shrink(1)
        .min_h(0)
        .overflow_y_scroll()
        .p(14)
        .gap(12)
        .child(
          h_flex()
            .w_full()
            .items_center()
            .gap(8)
            .when(Boolean(iconEl), (el) => el.child(iconEl))
            .child(
              v_flex()
                .min_w(0)
                .child(div().text_size(14).font_semibold().text_color(t.foreground).child(name))
                .child(div().text_size(11).text_color(t.muted).child(updatedText(data.fetchedAt, now)))
            )
        )
        .child(div().w_full().h(1).flex_none().bg(t.border))
        .when(p.status === "error" && Boolean(p.error), (el) =>
          el.child(div().text_size(11).text_color(t.blocked).child(p.error))
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
              .child(this.bar(t, pct))
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
    const selectedProvider = available.find((p) => p.id === this.selected) ?? available[0] ?? null;
    const selectedId = selectedProvider?.id ?? null;

    const side = this.width >= LIST_W + GAP + DETAILS_W;
    const cardH = side ? height : Math.floor((height - GAP) / 2);
    const list = this.renderListCard(t, now, data, available, unavailable, selectedId, cardH);
    const details = this.renderDetailsCard(t, now, data, selectedProvider, cardH);

    // The root is see-through and fills the popup: a press on it (beside the cards) closes it.
    return div()
      .id("usage-root")
      .w_full()
      .h(height)
      .flex()
      .items_end()
      .text_size(12)
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
          ? h_flex().items_end().gap(GAP).child(list).child(details)
          : v_flex().gap(GAP).child(details).child(list)
      );
  }
}
