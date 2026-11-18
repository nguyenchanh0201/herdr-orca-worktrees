import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { shared, pickFolder } from "herdr";

export function renderRename(view, t) {
  return v_flex()
    .id("orca-project-rename")
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") { cx.stop_propagation(); view.close(); }
    })
    .size_full().p(12).gap(6).bg(t.popover).text_size(13)
    .child(div().font_semibold().text_color(t.foreground).child("Rename project"))
    .child(Input.new(view.nameInput).h(30).px(10).items_center().rounded(6)
      .border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
    .child(div().text_size(12).text_color(t.muted).child("Leave empty to use the folder name"))
    .when(Boolean(view.localError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(view.localError)))
    .child(h_flex().justify_end().child(
      div().id("save-project-name").h(30).px(14).flex().items_center().rounded(6)
        .bg(t.accent).text_color(t.background).font_semibold().cursor_pointer()
        .on_click((_e, cx) => view.submitRename(cx)).child("Save")
    ));
}

export function renderIcon(view, t) {
  return v_flex()
    .id("orca-project-icon")
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") { cx.stop_propagation(); view.close(); }
    })
    .size_full().p(12).gap(6).bg(t.popover).text_size(13)
    .child(div().font_semibold().text_color(t.foreground).child("Project icon"))
    .child(view.popupRow("icon-github", "GitHub avatar", (_e, cx) => view.submitIcon(cx, "github"), t))
    .child(view.popupRow("icon-repo", "Icon from repo", (_e, cx) => view.submitIcon(cx, "repo"), t))
    .child(view.popupRow("icon-letter", "Letter", (_e, cx) => view.submitIcon(cx, "letter"), t))
    .child(div().text_color(t.muted).child("Custom…"))
    .child(h_flex().gap(8).child(
      Input.new(view.iconInput).flex_1().h(30).px(10).items_center().rounded(6)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).disabled(view.working)
    ).child(
      div().id("apply-project-icon").h(30).px(14).flex().items_center().rounded(6)
        .bg(t.accent).text_color(t.background).font_semibold().cursor_pointer().disabled(view.working)
        .on_click((_e, cx) => view.submitIcon(cx, "custom")).child("Apply")
    ))
    .when(view.working, (el) => el.child(div().text_color(t.muted).child("Working…")))
    .when(Boolean(view.localError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(view.localError)));
}

export function renderClone(view, t) {
  const clone = view.reqId ? shared("orca.projects.clone") : null;
  const activeClone = clone?.id === view.reqId ? clone : null;
  const running = activeClone?.state === "running";
  const err = view.localError || (activeClone?.state === "error" ? activeClone.error : "");

  const inputStyle = (state, focused, flex1 = false) =>
    Input.new(state)
      .h(30)
      .px(10)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(focused ? t.accent : t.input)
      .bg(t.background)
      .text_color(t.foreground)
      .disabled(running)
      .when(flex1, (el) => el.flex_1());

  return v_flex()
    .id("orca-project-clone")
    .track_focus(view.handle)
    .on_key_down((e, cx) => {
      if (e.key === "escape") {
        cx.stop_propagation();
        view.close();
      }
    })
    .size_full()
    .p(16)
    .gap(10)
    .bg(t.popover)
    .text_size(13)
    .child(div().font_semibold().text_color(t.foreground).child("Clone from URL"))
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().w(96).flex_none().text_color(t.muted).child("Git URL"))
        .child(inputStyle(view.urlInput, view.focusedField === "url", true))
    )
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().w(96).flex_none().text_color(t.muted).child("Parent folder"))
        .child(inputStyle(view.parentInput, view.focusedField === "parent", true))
        .child(
          div()
            .id("choose-parent")
            .flex_none()
            .h(30)
            .px(10)
            .flex()
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(t.input)
            .bg(t.background)
            .text_color(running ? t.dim : t.foreground)
            .cursor_pointer()
            .disabled(running)
            .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => {
              if (running) return;
              cx.spawn(async (cx) => {
                const f = await pickFolder({ prompt: "Choose parent folder" });
                if (f) {
                  view.parentEdited = true;
                  view.parentInput.set_value(f);
                  view.localError = "";
                  cx.notify();
                }
              });
            })
            .child("Choose…")
        )
    )
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().w(96).flex_none().text_color(t.muted).child("Folder name"))
        .child(inputStyle(view.nameInput, view.focusedField === "name", true))
    )
    .when(Boolean(err), (el) => el.child(div().text_size(12).text_color(t.blocked).child(err)))
    .child(div().flex_1())
    .child(
      h_flex()
        .justify_end()
        .gap(8)
        .child(
          div()
            .id("cancel-clone")
            .h(30)
            .px(12)
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
            .id("submit-clone")
            .h(30)
            .px(14)
            .flex()
            .items_center()
            .rounded(6)
            .bg(running ? t.hover : t.accent)
            .text_color(running ? t.muted : t.background)
            .font_semibold()
            .cursor_pointer()
            .disabled(running)
            .on_click((_e, cx) => view.submitClone(cx))
            .child(running ? "Cloning…" : "Clone")
        )
    );
}
