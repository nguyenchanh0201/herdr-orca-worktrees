import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { props, closeOverlay, openOverlay, exec, notify, setShared } from "herdr";
import config from "./config.js";

export function renderGroup(view, t) {
  const p = props();
  const wrap = v_flex()
    .id("orca-project-group")
    .w_full()
    .bg(t.popover)
    .p(5)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") {
        view.close();
        if (p.parent) closeOverlay(p.parent);
      }
    });

  if (view.backMode) {
    wrap
      .child(
        view.popupRow(
          "group-back",
          "‹ Back",
          (_e, cx) => {
            view.mode = view.backMode;
            view.backMode = null;
            cx.notify();
          },
          t
        )
      )
      .child(div().h(1).my(4).bg(t.border));
  }

  wrap
    .child(
      view.popupRow(
        "new-group-from-project",
        "New group from project…",
        () => {
          view.close();
          if (p.parent) closeOverlay(p.parent);
          openOverlay({
            mod: "orca-project",
            kind: "dialog",
            width: 420,
            height: 228,
            props: {
              mode: "new-group",
              path: p.path,
              name: p.name,
              groups: Array.isArray(p.groups) ? p.groups : [],
            },
          });
        },
        t
      )
    )
    .when(Boolean(p.group), (el) =>
      el.child(
        view.popupRow(
          "remove-from-group",
          "Remove from group",
          async () => {
            try {
              const res = await exec(config.node, [config.cli, "projects", "set-group", p.path]);
              const parsed = JSON.parse(res.stdout || "{}");
              if (parsed?.error) {
                notify({ title: "Project Group", body: parsed.error, level: "error" });
                return;
              }
            } catch (err) {
              notify({ title: "Project Group", body: err?.message ?? String(err), level: "error" });
              return;
            }
            setShared("orca.projects.rev", Date.now());
            view.close();
            if (p.parent) closeOverlay(p.parent);
          },
          t
        )
      )
    );

  const curLower = typeof p.group === "string" ? p.group.trim().toLowerCase() : "";
  const others = (Array.isArray(p.groups) ? p.groups : []).filter(
    (g) => typeof g === "string" && g.trim() && g.trim().toLowerCase() !== curLower
  );
  if (others.length > 0) {
    wrap.child(div().px(9).pt(6).pb(2).text_size(11).text_color(t.dim).child("Move to group"));
    for (const g of others) {
      wrap.child(
        h_flex()
          .id(`move-group-${g}`)
          .h(31)
          .px(9)
          .gap(6)
          .rounded(7)
          .items_center()
          .flex_none()
          .cursor_pointer()
          .text_color(t.foreground)
          .hover((s) => s.bg(t.selected))
          .on_click(async () => {
            try {
              const res = await exec(config.node, [config.cli, "projects", "set-group", p.path, g]);
              const parsed = JSON.parse(res.stdout || "{}");
              if (parsed?.error) {
                notify({ title: "Project Group", body: parsed.error, level: "error" });
                return;
              }
            } catch (err) {
              notify({ title: "Project Group", body: err?.message ?? String(err), level: "error" });
              return;
            }
            setShared("orca.projects.rev", Date.now());
            view.close();
            if (p.parent) closeOverlay(p.parent);
          })
          .child(div().flex_none().text_size(10).text_color(t.muted).child("●"))
          .child(div().flex_1().truncate().child(g))
      );
    }
  }
  return wrap;
}

export function renderNewGroup(view, t) {
  const empty = !view.groupInput.value().trim();
  return v_flex()
    .id("orca-project-new-group")
    .size_full()
    .bg(t.popover)
    .p(16)
    .gap(10)
    .text_size(13)
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") {
        cx.stop_propagation();
        view.close();
      }
    })
    .child(div().font_semibold().text_size(14).text_color(t.foreground).child("New Project Group"))
    .child(div().text_size(12).text_color(t.muted).child("Create a group and move this project into it."))
    .child(
      v_flex()
        .gap(4)
        .child(div().text_size(12).text_color(t.muted).child("Group Name"))
        .child(
          Input.new(view.groupInput)
            .h(30)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.accent)
            .bg(t.background)
            .text_color(t.foreground)
        )
    )
    .when(Boolean(view.localError), (el) =>
      el.child(div().text_size(11.5).text_color(t.blocked).child(view.localError))
    )
    .child(div().flex_1())
    .child(
      h_flex()
        .justify_end()
        .gap(6)
        .pt(4)
        .child(
          div()
            .id("new-group-cancel")
            .h(28)
            .px(10)
            .flex()
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.input)
            .text_color(t.muted)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => view.close())
            .child("Cancel")
        )
        .child(
          div()
            .id("new-group-create")
            .h(28)
            .px(10)
            .flex()
            .items_center()
            .rounded(6)
            .bg(empty ? t.hover : t.accent)
            .text_color(empty ? t.dim : t.background)
            .font_semibold()
            .when(!empty, (el) => el.cursor_pointer().on_click((_e, cx) => view.submitNewGroup(cx)))
            .child("Create")
        )
    );
}
