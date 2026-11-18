import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run } from "herdr";
import { fmtMem, fmtCpu } from "./fmt.js";

export function renderResourcesTab(view, t, snap) {
  const cpu = snap?.cpu ?? 0;
  const rss = snap?.rss ?? 0;
  const projects = view.sortStable(snap?.projects, (p) => p.key, "projects");
  const other = view.sortStable(snap?.other, (r) => r.address, "other");
  const herdr = snap?.herdr ?? { cpu: 0, rss: 0 };

  return v_flex()
    .w_full()
    .flex_1()
    .overflow_hidden()
    .child(view.renderConfirmAndErrors(t, snap))
    .child(
      v_flex()
        .w_full()
        .px(12)
        .py(10)
        .gap(6)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .w_full()
            .items_baseline()
            .gap(10)
            .child(div().text_size(15).font_bold().text_color(t.foreground).child(fmtCpu(cpu)))
            .child(div().text_size(15).font_bold().text_color(t.foreground).child(fmtMem(rss)))
            .child(div().text_size(11).text_color(t.dim).child("Σ RSS")),
        )
        .child(
          div()
            .id("metric-details-toggle")
            .cursor_pointer()
            .text_size(11)
            .text_color(t.muted)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              view.detailsOpen = !view.detailsOpen;
              cx.notify();
            })
            .child(view.detailsOpen ? "▾ " : "▸ ")
            .child("Metric details"),
        )
        .when(view.detailsOpen, (el) =>
          el.child(
            v_flex()
              .gap(3)
              .pl(10)
              .text_size(11)
              .text_color(t.dim)
              .child("CPU is the sum of each process's %cpu from ps.")
              .child("Memory is the resident memory (RSS) of each terminal's process and all its children."),
          ),
        ),
    )
    .child(view.renderSortHeader(t))
    .child(
      v_flex()
        .w_full()
        .flex_1()
        .overflow_y_scroll()
        .children(
          projects.map((proj) => {
            const projFolded = view.folded.has(`p:${proj.key}`);
            const worktrees = view.sortStable(proj.worktrees, (w) => w.key, `p:${proj.key}`);
            return v_flex()
              .w_full()
              .child(
                h_flex()
                  .id(`proj-${proj.key}`)
                  .w_full()
                  .px(12)
                  .py(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => view.toggleFold(`p:${proj.key}`, cx))
                  .child(
                    h_flex()
                      .flex_1()
                      .items_center()
                      .gap(6)
                      .overflow_hidden()
                      .child(div().text_size(10).text_color(t.dim).child(projFolded ? "▸" : "▾"))
                      .child(div().text_size(11).font_bold().text_color(t.muted).child(proj.name.toUpperCase())),
                  )
                  .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(proj.cpu)))
                  .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(proj.rss))),
              )
              .when(!projFolded, (el) =>
                el.children(
                  worktrees.map((wt) => {
                    const wtFolded = view.folded.has(`w:${wt.key}`);
                    const terms = view.sortStable(wt.terminals, (r) => r.address, `w:${wt.key}`);
                    return v_flex()
                      .w_full()
                      .child(
                        h_flex()
                          .id(`wt-${wt.key}`)
                          .w_full()
                          .pl(20)
                          .pr(12)
                          .py(5)
                          .cursor_pointer()
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => view.toggleFold(`w:${wt.key}`, cx))
                          .child(
                            h_flex()
                              .flex_1()
                              .items_center()
                              .gap(6)
                              .overflow_hidden()
                              .child(div().text_size(10).text_color(t.dim).child(wtFolded ? "▸" : "▾"))
                              .child(div().text_size(12).text_color(t.foreground).child(wt.name))
                              .child(view.renderSparkline(t, snap?.history?.[wt.key])),
                          )
                          .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(wt.cpu)))
                          .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(wt.rss))),
                      )
                      .when(!wtFolded, (el2) =>
                        el2.children(
                          terms.map((row) =>
                            h_flex()
                              .id(`res-term-${row.address}`)
                              .w_full()
                              .pl(34)
                              .pr(12)
                              .py(4)
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click(() => run("pane.focus", { terminal: row.address }))
                              .child(
                                h_flex()
                                  .flex_1()
                                  .items_center()
                                  .gap(6)
                                  .overflow_hidden()
                                  .child(div().w(6).h(6).rounded(3).flex_none().bg(t.working))
                                  .child(div().text_size(12).text_color(t.foreground).child(row.label)),
                              )
                              .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(row.cpu)))
                              .child(div().w(66).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(row.rss)))
                              .child(
                                div()
                                  .id(`res-end-${row.address}`)
                                  .ml(6)
                                  .px(5)
                                  .py(1)
                                  .rounded(4)
                                  .flex_none()
                                  .cursor_pointer()
                                  .text_size(11)
                                  .text_color(t.blocked)
                                  .hover((s) => s.bg(t.selected))
                                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                  .on_click((_e, cx) => {
                                    cx.stop_propagation();
                                    view.confirming = [row.address];
                                    cx.notify();
                                  })
                                  .child("End"),
                              ),
                          ),
                        ),
                      );
                  }),
                ),
              );
          }),
        )
        .when(other.length > 0, (el) => {
          const otherFolded = view.folded.has("other");
          return el.child(
            v_flex()
              .w_full()
              .child(
                h_flex()
                  .id("group-other")
                  .w_full()
                  .px(12)
                  .py(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => view.toggleFold("other", cx))
                  .child(
                    h_flex()
                      .flex_1()
                      .items_center()
                      .gap(6)
                      .child(div().text_size(10).text_color(t.dim).child(otherFolded ? "▸" : "▾"))
                      .child(div().text_size(11).font_bold().text_color(t.muted).child("Other terminals")),
                  )
                  .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(other.reduce((s, r) => s + r.cpu, 0))))
                  .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(other.reduce((s, r) => s + r.rss, 0)))),
              )
              .when(!otherFolded, (el2) =>
                el2.children(
                  other.map((row) =>
                    h_flex()
                      .id(`res-other-${row.address}`)
                      .w_full()
                      .pl(28)
                      .pr(12)
                      .py(4)
                      .child(div().flex_1().text_size(12).text_color(t.foreground).child(row.label))
                      .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(row.cpu)))
                      .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(row.rss))),
                  ),
                ),
              ),
          );
        })
        .child(
          v_flex()
            .w_full()
            .child(
              h_flex()
                .id("group-herdr")
                .w_full()
                .px(12)
                .py(6)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => view.toggleFold("herdr", cx))
                .child(
                  h_flex()
                    .flex_1()
                    .items_center()
                    .gap(6)
                    .child(div().text_size(10).text_color(t.dim).child(view.folded.has("herdr") ? "▸" : "▾"))
                    .child(div().text_size(11).font_bold().text_color(t.muted).child("Herdr")),
                )
                .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(herdr.cpu)))
                .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(herdr.rss))),
            )
            .when(!view.folded.has("herdr"), (el) =>
              el.child(
                h_flex()
                  .w_full()
                  .pl(28)
                  .pr(12)
                  .py(4)
                  .child(div().flex_1().text_size(12).text_color(t.dim).child("Herdr.app & herdr-core"))
                  .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(herdr.cpu)))
                  .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(herdr.rss))),
              ),
            ),
        ),
    );
}
