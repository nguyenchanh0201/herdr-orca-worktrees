import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run } from "herdr";

function formatObservedTime(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function renderPtysTab(view, t, snap) {
  const projects = Array.isArray(snap?.projects) ? snap.projects : [];
  const allRows = view.allHerdrRows(snap);
  const count = snap?.count ?? allRows.length;
  const validAddrs = new Set(allRows.map((r) => r.address));
  const selectedAddrs = Array.from(view.selected).filter((a) => validAddrs.has(a));
  const allSelected = allRows.length > 0 && selectedAddrs.length === allRows.length;

  return v_flex()
    .w_full()
    .flex_1()
    .overflow_hidden()
    .child(
      v_flex()
        .w_full()
        .px(12)
        .py(10)
        .gap(6)
        .border_b(1)
        .border_color(t.border)
        .child(
          div()
            .text_size(12)
            .font_bold()
            .text_color(t.foreground)
            .child(`${count} Herdr terminals on this computer`),
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(`Last observed ${formatObservedTime(snap?.at)}`),
        )
        .child(
          h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .pt(2)
            .child(
              h_flex()
                .id("pty-select-all")
                .items_center()
                .gap(6)
                .cursor_pointer()
                .on_click((_e, cx) => {
                  if (allSelected) view.selected.clear();
                  else for (const r of allRows) view.selected.add(r.address);
                  cx.notify();
                })
                .child(
                  div()
                    .w(14)
                    .h(14)
                    .rounded(3)
                    .border(1)
                    .border_color(allSelected ? t.accent : t.border)
                    .when(allSelected, (el) => el.bg(t.accent))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(10)
                    .text_color(t.foreground)
                    .child(allSelected ? "✓" : ""),
                )
                .child(div().text_size(11).text_color(t.muted).child("Select all")),
            )
            .child(
              (() => {
                const base = div()
                  .id("pty-end-selected")
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11)
                  .text_color(selectedAddrs.length > 0 ? t.blocked : t.dim)
                  .bg(t.raised)
                  .child(`End selected (${selectedAddrs.length})`);
                return selectedAddrs.length > 0
                  ? base.cursor_pointer().on_click((_e, cx) => {
                      view.confirming = selectedAddrs;
                      cx.notify();
                    })
                  : base;
              })(),
            ),
        ),
    )
    .child(view.renderConfirmAndErrors(t, snap))
    .child(
      v_flex()
        .w_full()
        .flex_1()
        .overflow_y_scroll()
        .children(
          projects.map((proj) => {
            const projCount = (proj.worktrees ?? []).reduce(
              (s, w) => s + (w.terminals?.length ?? 0),
              0,
            );
            return v_flex()
              .w_full()
              .child(
                h_flex()
                  .w_full()
                  .px(12)
                  .py(6)
                  .items_center()
                  .justify_between()
                  .child(
                    div()
                      .text_size(11)
                      .font_bold()
                      .text_color(t.muted)
                      .child(proj.name.toUpperCase()),
                  )
                  .child(div().text_size(11).text_color(t.dim).child(String(projCount))),
              )
              .children(
                (proj.worktrees ?? []).map((wt) =>
                  v_flex()
                    .w_full()
                    .child(
                      h_flex()
                        .w_full()
                        .pl(20)
                        .pr(12)
                        .py(4)
                        .items_center()
                        .justify_between()
                        .child(div().text_size(11).text_color(t.muted).child(wt.name))
                        .child(div().text_size(11).text_color(t.dim).child(String(wt.terminals?.length ?? 0))),
                    )
                    .children(
                      (wt.terminals ?? []).map((row) => {
                        const checked = view.selected.has(row.address);
                        const unfolded = view.unfoldedPtys.has(row.address);
                        const detail = view.ptyDetails.get(row.address);
                        const argvStr = Array.isArray(detail?.foreground?.argv)
                          ? detail.foreground.argv.join(" ")
                          : "";
                        return v_flex()
                          .w_full()
                          .child(
                            h_flex()
                              .w_full()
                              .pl(24)
                              .pr(12)
                              .py(4)
                              .items_center()
                              .gap(6)
                              .hover((s) => s.bg(t.hover))
                              .child(
                                div()
                                  .id(`pty-check-${row.address}`)
                                  .w(14)
                                  .h(14)
                                  .flex_none()
                                  .rounded(3)
                                  .border(1)
                                  .border_color(checked ? t.accent : t.border)
                                  .when(checked, (el) => el.bg(t.accent))
                                  .cursor_pointer()
                                  .flex()
                                  .items_center()
                                  .justify_center()
                                  .text_size(10)
                                  .text_color(t.foreground)
                                  .on_click((_e, cx) => {
                                    if (checked) view.selected.delete(row.address);
                                    else view.selected.add(row.address);
                                    cx.notify();
                                  })
                                  .child(checked ? "✓" : ""),
                              )
                              .child(
                                div()
                                  .id(`pty-fold-${row.address}`)
                                  .px(2)
                                  .cursor_pointer()
                                  .text_size(11)
                                  .text_color(t.dim)
                                  .on_click((_e, cx) => view.togglePtyDetails(row.address, cx))
                                  .child(unfolded ? "▾" : "›"),
                              )
                              .child(
                                div()
                                  .flex_1()
                                  .text_size(12)
                                  .text_color(t.foreground)
                                  .child(row.label),
                              )
                              .child(
                                div()
                                  .id(`pty-jump-${row.address}`)
                                  .px(4)
                                  .cursor_pointer()
                                  .text_size(11)
                                  .text_color(t.muted)
                                  .hover((s) => s.text_color(t.foreground))
                                  .on_click(() => run("pane.focus", { terminal: row.address }))
                                  .child("↗"),
                              )
                              .child(
                                div()
                                  .id(`pty-end-${row.address}`)
                                  .px(6)
                                  .py(2)
                                  .rounded(4)
                                  .cursor_pointer()
                                  .text_size(11)
                                  .text_color(t.blocked)
                                  .hover((s) => s.bg(t.selected))
                                  .on_click((_e, cx) => {
                                    view.confirming = [row.address];
                                    cx.notify();
                                  })
                                  .child("End"),
                              ),
                          )
                          .when(unfolded, (el) =>
                            el.child(
                              v_flex()
                                .pl(46)
                                .pr(12)
                                .pb(6)
                                .gap(2)
                                .text_size(11)
                                .text_color(t.dim)
                                .child(`Address: ${row.address} · PID: ${detail?.pid ?? row.pid ?? "—"}`)
                                .when(Boolean(detail?.cwd), (d) => d.child(`Folder: ${detail.cwd}`))
                                .when(Boolean(argvStr), (d) => d.child(`Program: ${argvStr}`))
                                .when(Boolean(detail?.created_ms), (d) =>
                                  d.child(`Started: ${formatObservedTime(detail.created_ms)}`),
                                ),
                            ),
                          );
                      }),
                    ),
                ),
              );
          }),
        ),
    );
}
