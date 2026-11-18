import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Select, Popup } from "gpui-base";
import { openOverlay } from "herdr";

export function renderProjectField(view, repos, running, t) {
  const selectedRepo = repos.find((r) => r.primary === view.repo) ?? repos[0] ?? null;
  if (!view.repo && selectedRepo) {
    view.repo = selectedRepo.primary;
  }

  const trigger = h_flex()
    .id("project-trigger")
    .flex_1()
    .h(30)
    .px(10)
    .gap(8)
    .items_center()
    .rounded(6)
    .border(1)
    .border_color(view.projectOpen ? t.accent : t.input)
    .bg(t.background)
    .text_color(selectedRepo ? t.foreground : t.dim)
    .cursor_pointer()
    .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => {
      if (running) return;
      view.projectOpen = !view.projectOpen;
      view.baseOpen = false;
      view.agentOpen = false;
      cx.notify();
    })
    .child(div().flex_1().truncate().child(selectedRepo ? selectedRepo.name : "No projects"))
    .child(div().flex_none().text_color(t.dim).text_size(11).child("⇕"));

  const popupList = v_flex()
    .w(340)
    .max_h(220)
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .p(4)
    .overflow_y_scrollbar()
    .children(
      repos.map((r) => {
        const active = r.primary === view.repo;
        return h_flex()
          .id(`proj-opt-${r.key}`)
          .h(28)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.selected))
          .on_click((_e, cx) => {
            view.projectOpen = false;
            if (r.primary !== view.repo) {
              view.repo = r.primary;
              view.localError = "";
              view.loadBranches(r.primary, cx);
            } else {
              cx.notify();
            }
          })
          .child(div().w(14).flex_none().text_color(t.accent).child(active ? "✓" : ""))
          .child(div().flex_1().truncate().text_color(t.foreground).child(r.name));
      })
    )
    .when(repos.length === 0, (el) =>
      el.child(div().px(8).py(6).text_color(t.dim).child("No projects available"))
    );

  return v_flex()
    .gap(5)
    .child(
      h_flex()
        .items_center()
        .justify_between()
        .child(div().text_size(12).text_color(t.muted).child("Project"))
        .child(
          h_flex()
            .id("worktree-add-project")
            .w(22)
            .h(22)
            .items_center()
            .justify_center()
            .rounded(5)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() =>
              openOverlay({
                mod: "orca-project",
                kind: "popup",
                width: 220,
                height: 90,
                props: { mode: "add" },
              })
            )
            .child(svg("mods/workspace-chrome/folder-plus.svg").size(14))
        )
    )
    .child(
      Select.new("worktree-project-select")
        .accessibility_label("Project")
        .open(view.projectOpen)
        .track_focus(view.projectTriggerFocus)
        .content_focus_handle(view.projectListFocus)
        .on_open_change((open, cx) => {
          view.projectOpen = open;
          cx.notify();
        })
        .child(
          Popup.new("worktree-project-popup", trigger)
            .anchor("bottom_left")
            .when(view.projectOpen, (el) => el.content(popupList))
        )
    );
}
