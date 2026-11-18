import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { openOverlay, props, shared, setShared, exec } from "herdr";
import config from "./config.js";

export function popupRow(view, id, label, onClick, t) {
  return h_flex()
    .id(id)
    .h(31)
    .px(9)
    .rounded(7)
    .items_center()
    .flex_none()
    .cursor_pointer()
    .text_color(t.foreground)
    .hover((s) => s.bg(t.selected))
    .on_click(onClick)
    .child(div().flex_1().child(label));
}

export function subRow(view, id, label, onOpen, t) {
  return h_flex()
    .id(id)
    .h(31)
    .px(9)
    .rounded(7)
    .items_center()
    .flex_none()
    .cursor_pointer()
    .text_color(t.foreground)
    .hover((s) => s.bg(t.selected))
    .on_click((_e, cx) => onOpen(cx))
    .child(div().flex_1().child(label))
    .child(div().flex_none().text_color(t.dim).child("›"));
}

export function renderAdd(view, t) {
  return v_flex()
    .id("orca-project-add")
    .w_full()
    .bg(t.popover)
    .p(5)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") view.close();
    })
    .child(
      view.popupRow(
        "choose-folder",
        "Choose folder…",
        () => {
          setShared("orca.projects.request", { id: Date.now(), kind: "pick" });
          view.close();
        },
        t
      )
    )
    .child(
      view.popupRow(
        "clone-url",
        "Clone from URL…",
        () => {
          view.close();
          openOverlay({
            mod: "orca-project",
            kind: "dialog",
            width: 520,
            height: 230,
            props: { mode: "clone" },
          });
        },
        t
      )
    );
}

export function renderHeader(view, t) {
  const p = props();
  return v_flex()
    .id("orca-project-header")
    .w_full()
    .bg(t.popover)
    .p(5)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") view.close();
    })
    .when(Boolean(p.path), (el) =>
      el
        .child(view.subRow("open-in", "Open in", (cx) => view.openOpenIn(p.path, cx), t))
        .child(view.subRow("project-group", "Project Group", (cx) => view.openGroupMenu(cx), t))
    )
    .when(Boolean(p.saved), (el) =>
      el.child(
        view.popupRow("rename-project", "Rename…", () => {
          view.close();
          openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 160,
            props: { mode: "rename", path: p.path, name: p.name } });
        }, t)
      ).child(
        view.popupRow("change-project-icon", "Change icon…", () => {
          view.close();
          openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 260,
            props: { mode: "icon", path: p.path } });
        }, t)
      ).child(
        view.popupRow(
          "remove-project",
          "Remove from sidebar",
          async () => {
            await exec(config.node, [config.cli, "projects", "remove", p.path]);
            setShared("orca.projects.rev", Date.now());
            view.close();
          },
          t
        )
      )
    )
    .when(!p.saved, (el) =>
      el.child(
        div()
          .px(9)
          .py(6)
          .text_color(t.dim)
          .child("Not saved — it shows while its spaces are open")
      )
    );
}

export function renderOptions(view, t) {
  const cur = shared("orca.projects.options") ?? {};
  const divider = () => div().h(1).my(4).mx(6).bg(t.border);
  const checkRow = (id, label, checked, onClick) =>
    h_flex()
      .id(id)
      .h(31)
      .px(9)
      .rounded(7)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.selected))
      .on_click(onClick)
      .child(div().flex_1().child(label))
      .child(div().w(16).flex_none().text_color(t.accent).child(checked ? "✓" : ""));

  return v_flex()
    .id("orca-project-options")
    .w_full()
    .bg(t.popover)
    .p(5)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") view.close();
    })
    .child(
      view.popupRow(
        "collapse-all-projects",
        "Collapse all projects",
        () => {
          setShared("orca.projects.options", { ...cur, collapse: "all", at: Date.now() });
          view.close();
        },
        t
      )
    )
    .child(
      view.popupRow(
        "expand-all-projects",
        "Expand all projects",
        () => {
          setShared("orca.projects.options", { ...cur, collapse: "none", at: Date.now() });
          view.close();
        },
        t
      )
    )
    .child(divider())
    .child(
      div()
        .px(9)
        .py(4)
        .text_size(11)
        .font_semibold()
        .text_color(t.muted)
        .child("Sort projects")
    )
    .child(
      checkRow("sort-added", "Order added", cur.sort !== "name", (_e, cx) => {
        setShared("orca.projects.options", { sort: "added", hideMain: Boolean(cur.hideMain), at: Date.now() });
        cx.notify();
      })
    )
    .child(
      checkRow("sort-name", "Name", cur.sort === "name", (_e, cx) => {
        setShared("orca.projects.options", { sort: "name", hideMain: Boolean(cur.hideMain), at: Date.now() });
        cx.notify();
      })
    )
    .child(divider())
    .child(
      checkRow("hide-main", "Hide main checkouts", Boolean(cur.hideMain), (_e, cx) => {
        setShared("orca.projects.options", { sort: cur.sort ?? "added", hideMain: !cur.hideMain, at: Date.now() });
        cx.notify();
      })
    );
}
