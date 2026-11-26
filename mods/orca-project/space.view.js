import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, setShared, openOverlay } from "herdr";

export function renderSpace(view, t) {
  const p = props();
  const wrap = v_flex()
    .id("orca-project-space")
    .w_full()
    .bg(t.popover)
    .p(5)
    .text_size(12.8)
    .track_focus(view.handle)
    .on_key_down((e) => {
      if (e.key === "escape") view.close();
    });

  if (view.busyAgents) {
    const msg =
      view.busyAgents.length === 1
        ? `${view.busyAgents[0].name} is ${view.busyAgents[0].status === "blocked" ? "waiting for you" : "working"}. Sleep anyway?`
        : `${view.busyAgents.map((b) => b.name).join(", ")} are busy. Sleep anyway?`;

    return wrap
      .p(10)
      .gap(10)
      .child(div().text_size(12.4).text_color(t.foreground).child(msg))
      .child(
        h_flex()
          .justify_end()
          .gap(6)
          .child(
            div()
              .id("sleep-cancel")
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
              .id("sleep-confirm")
              .h(28)
              .px(10)
              .flex()
              .items_center()
              .rounded(6)
              .bg(t.accent)
              .text_color(t.background)
              .font_semibold()
              .cursor_pointer()
              .on_click(() => {
                const id = Date.now();
                view.sleepReqId = id;
                setShared("orca.projects.request", { id, kind: "sleep", space: p.space, confirm: true });
                view.close();
              })
              .child("Sleep anyway")
          )
      );
  }

  return wrap
    .when(Boolean(p.folder || p.worktree), (el) =>
      el
        .child(view.subRow("open-in", "Open in", (cx) => view.openOpenIn(p.folder || p.worktree, cx), t))
        .child(
          view.popupRow(
            "space-commits",
            "Commits…",
            () => {
              view.close();
              openOverlay({
                mod: "orca-commits",
                kind: "dialog",
                width: 1050,
                height: 650,
                props: { folder: p.folder || p.worktree },
              });
            },
            t
          )
        )
    )
    .when(Boolean(p.hasAgents && !p.sleeping && p.space), (el) =>
      el.child(
        view.popupRow(
          "space-sleep",
          "Sleep",
          (_e, cx) => {
            if (view.sleepReqId) return;
            view.sleepReqId = Date.now();
            view.sleepError = null;
            setShared("orca.projects.request", { id: view.sleepReqId, kind: "sleep", space: p.space, confirm: false });
            cx.notify();
          },
          t
        )
      )
    )
    .when(Boolean(p.sleeping), (el) =>
      el.child(
        view.popupRow(
          "space-wake",
          "Wake",
          () => {
            setShared("orca.projects.request", { id: Date.now(), kind: "wake", worktree: p.worktree });
            view.close();
          },
          t
        )
      )
    )
    .when(Boolean(p.sleeping && !p.space), (el) =>
      el.child(
        view.popupRow(
          "space-forget-sleep",
          "Forget sleep",
          () => {
            setShared("orca.projects.request", { id: Date.now(), kind: "forget-sleep", worktree: p.worktree });
            view.close();
          },
          t
        )
      )
    )
    .when(Boolean(p.space), (el) =>
      el.child(
        view.popupRow(
          "space-menu",
          "Space menu…",
          () => {
            view.close();
            openOverlay({
              mod: "menu",
              kind: "popup",
              width: 200,
              height: 260,
              props: { tab: "space", target: { id: p.space } },
            });
          },
          t
        )
      )
    )
    .when(Boolean(view.sleepError), (el) =>
      el.child(div().px(9).py(4).text_size(11).text_color(t.blocked).child(view.sleepError))
    );
}
