import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, exec, notify, openOverlay } from "herdr";
import config from "./config.js";

export function appIconEl(view, app, t) {
  return app?.icon
    ? image(app.icon).size(14).rounded(3).flex_none()
    : svg("icons/folder.svg").size(14).flex_none().text_color(t.muted);
}

export function renderOpenIn(view, t) {
  const p = props();
  const folder = view.openInFolder ?? p.folder;
  const chosenApps = view.appsInstalled.filter((a) => view.appsChosen.has(a.id));
  const wrap = v_flex()
    .id("orca-project-open-in")
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
          "open-in-back",
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

  for (const app of chosenApps) {
    wrap.child(
      h_flex()
        .id(`open-in-${app.id}`)
        .h(31)
        .px(9)
        .gap(8)
        .rounded(7)
        .items_center()
        .flex_none()
        .cursor_pointer()
        .text_color(t.foreground)
        .hover((s) => s.bg(t.selected))
        .on_click(async () => {
          try {
            const res = await exec(config.node, [config.cli, "open", app.id, folder]);
            const parsed = JSON.parse(res.stdout || "{}");
            if (parsed?.error) {
              notify({ title: "Open in", body: parsed.error, level: "error" });
            }
          } catch (err) {
            notify({ title: "Open in", body: err?.message ?? String(err), level: "error" });
          }
          view.close();
          if (p.parent) closeOverlay(p.parent);
        })
        .child(view.appIconEl(app, t))
        .child(div().flex_1().truncate().child(app.name))
    );
  }

  return wrap
    .child(div().h(1).my(4).bg(t.border))
    .child(
      view.popupRow(
        "customize-apps",
        "Customize apps…",
        () => {
          view.close();
          if (p.parent) closeOverlay(p.parent);
          openOverlay({
            mod: "orca-project",
            kind: "dialog",
            width: 320,
            height: 360,
            props: { mode: "apps" },
          });
        },
        t
      )
    );
}

export function renderApps(view, t) {
  const checkRow = (id, app, checked, onClick) =>
    h_flex()
      .id(id)
      .h(30)
      .px(9)
      .gap(8)
      .rounded(7)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.selected))
      .on_click(onClick)
      .child(div().w(14).flex_none().text_color(checked ? t.foreground : t.dim).child(checked ? "✓" : ""))
      .child(view.appIconEl(app, t))
      .child(div().flex_1().text_color(t.foreground).child(app.name));

  const wrap = v_flex()
    .id("orca-project-apps")
    .w_full()
    .bg(t.popover)
    .p(14)
    .gap(8)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") view.close();
    })
    .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Customize apps"));

  for (const app of view.appsInstalled) {
    const checked = view.appsChosen.has(app.id);
    wrap.child(
      checkRow(`app-${app.id}`, app, checked, (_e, cx) => {
        if (view.appsChosen.has(app.id)) view.appsChosen.delete(app.id);
        else view.appsChosen.add(app.id);
        cx.notify();
      })
    );
  }

  return wrap.child(
    h_flex()
      .justify_end()
      .gap(6)
      .pt(6)
      .child(
        div()
          .id("apps-cancel")
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
          .id("apps-save")
          .h(28)
          .px(10)
          .flex()
          .items_center()
          .rounded(6)
          .bg(t.accent)
          .text_color(t.background)
          .font_semibold()
          .cursor_pointer()
          .on_click(async () => {
            const ids = view.appsInstalled.filter((a) => view.appsChosen.has(a.id)).map((a) => a.id);
            try {
              const res = await exec(config.node, [config.cli, "apps", "set", ...ids]);
              const parsed = JSON.parse(res.stdout || "{}");
              if (parsed?.error) {
                notify({ title: "Customize apps", body: parsed.error, level: "error" });
                return;
              }
            } catch (err) {
              notify({ title: "Customize apps", body: err?.message ?? String(err), level: "error" });
              return;
            }
            view.close();
          })
          .child("Save")
      )
  );
}
