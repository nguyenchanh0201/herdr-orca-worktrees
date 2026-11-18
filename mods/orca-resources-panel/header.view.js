import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { setShared } from "herdr";

export function renderSparkline(view, t, points) {
  if (!Array.isArray(points) || points.length === 0) {
    return div().w(48).h(14).flex_none();
  }
  const slice = points.slice(-24);
  let min = Infinity;
  let max = -Infinity;
  for (const v of slice) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  return h_flex()
    .w(48)
    .h(14)
    .flex_none()
    .items_end()
    .gap(1)
    .children(
      slice.map((v) => {
        const norm = span > 0 ? (v - min) / span : 0.5;
        const h = Math.max(2, Math.round(2 + norm * 12));
        return div().w(1).h(h).bg(t.muted);
      }),
    );
}

export function renderHeader(view, t, snap) {
  const count = snap?.count ?? 0;
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
        .child(
          h_flex()
            .items_center()
            .gap(6)
            .child(svg("orca-icons/chip.svg").size(14).flex_none().text_color(t.muted))
            .child(div().text_size(13).font_bold().text_color(t.foreground).child("Resource Manager")),
        )
        .child(
          div()
            .id("res-refresh")
            .px(8)
            .py(3)
            .rounded(4)
            .cursor_pointer()
            .text_size(11)
            .text_color(t.muted)
            .bg(t.raised)
            .border(1)
            .border_color(t.border)
            .hover((s) => s.text_color(t.foreground).bg(t.selected))
            .on_click((_e, cx) => {
              view.orderCache.clear();
              setShared("orca.resources.refresh", { at: Date.now() });
              cx.notify();
            })
            .child("Refresh"),
        ),
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
        .children([
          div()
            .id("tab-resources")
            .flex_1()
            .py(4)
            .rounded(4)
            .cursor_pointer()
            .flex()
            .items_center()
            .justify_center()
            .text_size(12)
            .when(view.tab === "resources", (el) => el.bg(t.selected))
            .text_color(view.tab === "resources" ? t.foreground : t.muted)
            .on_click((_e, cx) => view.setTab("resources", cx))
            .child("Resources"),
          div()
            .id("tab-ptys")
            .flex_1()
            .py(4)
            .rounded(4)
            .cursor_pointer()
            .flex()
            .items_center()
            .justify_center()
            .gap(6)
            .text_size(12)
            .when(view.tab === "ptys", (el) => el.bg(t.selected))
            .text_color(view.tab === "ptys" ? t.foreground : t.muted)
            .on_click((_e, cx) => view.setTab("ptys", cx))
            .child("PTYs")
            .child(
              div()
                .px(5)
                .py(1)
                .rounded(8)
                .bg(t.border)
                .text_size(10)
                .text_color(t.muted)
                .child(String(count)),
            ),
        ]),
    );
}

export function renderSortHeader(view, t) {
  const cols = [
    { id: "name", label: "Name", flex: true },
    { id: "cpu", label: "CPU", width: 54 },
    { id: "mem", label: "Mem", width: 72 },
  ];
  return h_flex()
    .w_full()
    .px(12)
    .py(6)
    .border_b(1)
    .border_color(t.border)
    .text_size(11)
    .text_color(t.dim)
    .children(
      cols.map((col) => {
        const active = view.sort.by === col.id;
        const arrow = active ? (view.sort.dir === "desc" ? " ↓" : " ↑") : "";
        const el = div()
          .id(`sort-${col.id}`)
          .cursor_pointer()
          .text_color(active ? t.foreground : t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => view.toggleSort(col.id, cx))
          .child(col.label)
          .when(Boolean(arrow), (d) => d.child(arrow));
        return col.flex ? el.flex_1() : el.w(col.width).flex_none().flex().justify_end();
      }),
    );
}

export function renderConfirmAndErrors(view, t, snap) {
  return v_flex()
    .w_full()
    .when(Boolean(view.confirming?.length), (el) =>
      el.child(
        v_flex()
          .w_full()
          .px(12)
          .py(8)
          .gap(6)
          .bg(t.raised)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .text_size(11)
              .text_color(t.foreground)
              .child(view.confirmMessage(view.confirming, snap)),
          )
          .child(
            h_flex()
              .gap(8)
              .justify_end()
              .child(
                div()
                  .id("pty-confirm-cancel")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .cursor_pointer()
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(t.muted)
                  .on_click((_e, cx) => {
                    view.confirming = null;
                    cx.notify();
                  })
                  .child("Cancel"),
              )
              .child(
                div()
                  .id("pty-confirm-end")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .cursor_pointer()
                  .bg(t.blocked)
                  .text_size(11)
                  .text_color(t.foreground)
                  .on_click((_e, cx) => view.endTerminals(view.confirming, snap, cx))
                  .child("End"),
              ),
          ),
      ),
    )
    .when(view.endErrors.length > 0, (el) =>
      el.child(
        v_flex()
          .w_full()
          .px(12)
          .py(6)
          .gap(2)
          .border_b(1)
          .border_color(t.border)
          .children(
            view.endErrors.map((err) =>
              div().text_size(11).text_color(t.blocked).child(err),
            ),
          ),
      ),
    );
}
