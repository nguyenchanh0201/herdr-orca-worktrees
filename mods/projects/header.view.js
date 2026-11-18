import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, openOverlay } from "herdr";
import { attentionCount, colorIndex, letterOf } from "./group.js";

const PALETTE = ["#c2410c", "#b45309", "#4d7c0f", "#047857", "#0e7490", "#1d4ed8", "#6d28d9", "#be185d"];

export function renderTopHeader(view, targetRepo, t) {
  const anyOpen = view.groupKeys.some((k) => !view.collapsed.has(k));
  const attn = attentionCount(agents());

  const iconBtn = (id, active = false, disabled = false) =>
    h_flex()
      .id(id)
      .size(26)
      .items_center()
      .justify_center()
      .rounded(6)
      .flex_none()
      .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!active && !disabled, (el) =>
        el.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      )
      .when(!active && disabled, (el) => el.text_color(t.dim))
      .when(active, (el) => el.cursor_pointer());

  const bellBtn = iconBtn("projects-view-bell", view.view === "activity")
    .relative()
    .on_click((_e, cx) => {
      view.view = view.view === "activity" ? "projects" : "activity";
      try {
        localStorage.setItem("projects.view", view.view);
      } catch {}
      cx.notify();
    })
    .child(svg("orca-icons/bell.svg").size(14))
    .when(attn > 0, (el) =>
      el.child(
        div()
          .absolute()
          .top(1)
          .right(1)
          .px(3)
          .rounded(6)
          .bg(t.blocked)
          .text_color(t.background)
          .text_size(9)
          .font_bold()
          .child(String(attn))
      )
    );

  const optionsBtn = iconBtn("projects-options-btn")
    .on_click(() =>
      openOverlay({
        mod: "orca-project",
        kind: "popup",
        width: 240,
        height: 260,
        props: { mode: "options" },
      })
    )
    .child(svg("orca-icons/sliders.svg").size(14));

  const addProjectBtn = iconBtn("projects-add-btn")
    .on_click(() =>
      openOverlay({
        mod: "orca-project",
        kind: "popup",
        width: 220,
        height: 90,
        props: { mode: "add" },
      })
    )
    .child(svg("mods/workspace-chrome/folder-plus.svg").size(14));

  const newWorktreeBtn = iconBtn("projects-new-worktree-btn", false, !targetRepo)
    .when(Boolean(targetRepo), (el) =>
      el.on_click(() =>
        openOverlay({
          mod: "orca-worktree",
          kind: "dialog",
          width: 560,
          height: 420,
          props: { repo: targetRepo },
        })
      )
    )
    .child(svg("mods/workspace-chrome/plus.svg").size(14));

  return h_flex()
    .id("projects-top-header")
    .h(32)
    .px(10)
    .gap(4)
    .items_center()
    .flex_none()
    .child(
      div()
        .text_size(12)
        .font_semibold()
        .text_color(t.muted)
        .child(view.view === "activity" ? "Activity" : "Projects")
    )
    .child(
      h_flex()
        .id("projects-collapse-all")
        .size(20)
        .items_center()
        .justify_center()
        .rounded(4)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          if (anyOpen) {
            for (const k of view.groupKeys) view.collapsed.add(k);
          } else {
            view.collapsed.clear();
          }
          view.saveCollapsed();
          cx.notify();
        })
        .child(
          svg(anyOpen ? "mods/workspace-chrome/chevron-down.svg" : "mods/workspace-chrome/chevron-right.svg").size(12)
        )
    )
    .child(div().flex_1())
    .child(bellBtn)
    .child(optionsBtn)
    .child(addProjectBtn)
    .child(newWorktreeBtn);
}

export function renderGroupHeader(view, section, isCollapsed, t, first = false) {
  return h_flex()
    .id(`group-head-${section.key}`)
    .when(!first, (el) => el.mt(8))
    .h(28)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => view.toggleCollapsed(section.key, cx))
    .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
    .child(svg("orca-icons/groups.svg").size(14).flex_none().text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().font_bold().text_color(t.foreground).child(section.name));
}

export function renderHeader(view, g, isCollapsed, t, first = false, indented = false, groupNames = []) {
  const missing = g.kind === "repo" && g.exists === false;
  const head = h_flex()
    .id(`project-header-${g.key}`)
    // More space above a project than between its worktrees.
    .when(!first, (el) => el.mt(8))
    .when(indented, (el) => el.ml(14))
    .h(28)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => view.toggleCollapsed(g.key, cx))
    .when(g.kind === "repo", (el) =>
      el.on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({
          mod: "orca-project",
          kind: "popup",
          width: 220,
          height: 240,
          props: {
            mode: "header",
            path: g.primary,
            saved: Boolean(g.saved),
            name: g.displayName,
            group: g.group ?? null,
            groups: groupNames,
          },
        });
      })
    )
    .on_hover((h, cx) => {
      const k = h ? g.key : (view.hoverHeader === g.key ? null : view.hoverHeader);
      if (k !== view.hoverHeader) {
        view.hoverHeader = k;
        cx.notify();
      }
    })
    .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
    .when(g.kind === "repo", (el) => el.child(g.icon
      ? image(g.icon).size(16).rounded(3).flex_none()
      : div().size(16).rounded(3).flex_none().bg(PALETTE[colorIndex(g.key, PALETTE.length)])
        .flex().items_center().justify_center()
        .child(div().text_size(10).font_bold().text_color("#ffffff").child(letterOf(g.displayName)))))
    .child(div().flex_initial().truncate().text_color(missing ? t.dim : t.foreground).font_bold().child(g.kind === "repo" ? g.displayName : g.name))
    .child(div().flex_none().text_color(t.muted).child(String(g.rows.length)))
    .child(div().flex_1());

  if (missing) {
    head.child(div().flex_none().text_size(11).text_color(t.dim).child("missing"));
  } else if (g.kind === "repo" && view.hoverHeader === g.key) {
    head.child(
      div()
        .id(`project-add-${g.key}`)
        .flex_none()
        .px(4)
        .rounded(4)
        .text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .cursor_pointer()
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "orca-worktree",
            kind: "dialog",
            width: 560,
            height: 420,
            props: { repo: g.primary },
          });
        })
        .child("+")
    );
  }

  return head;
}
