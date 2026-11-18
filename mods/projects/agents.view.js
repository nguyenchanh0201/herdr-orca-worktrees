import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run } from "herdr";
import { elapsed } from "./group.js";

export function sleepingAgentIcon(view, sa, t) {
  const prog = view.knownAgentByKind?.get(sa.kind);
  return !prog?.icon
    ? svg("icons/agent.svg").size(13).flex_none().text_color(t.dim)
    : prog.tint
      ? svg(prog.icon).size(13).flex_none().text_color(t.dim)
      : image(prog.icon).size(13).flex_none();
}

export function renderSleepingAgent(view, sa, row, t, idx) {
  const id = row.space ? row.space.id : row.worktree;
  return h_flex()
    .id(`sleeping-agent-${id}-${idx}-${sa.name}`)
    .h(24)
    .pl(24)
    .pr(8)
    .gap(8)
    .items_center()
    .rounded(6)
    .child(view.sleepingAgentIcon(sa, t))
    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(sa.name ?? sa.kind ?? ""))
    .child(div().flex_none().text_color(t.dim).child("· asleep"));
}

export function renderActivitySleepingAgent(view, sa, row, spaceLabel, t, idx) {
  const id = row.space ? row.space.id : row.worktree;
  return v_flex()
    .id(`activity-sleeping-${id}-${idx}-${sa.name}`)
    .px(8)
    .py(5)
    .gap(2)
    .rounded(6)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(view.sleepingAgentIcon(sa, t))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(sa.name ?? sa.kind ?? ""))
        .child(svg("orca-icons/moon.svg").size(12).flex_none().text_color(t.dim))
        .child(div().flex_none().text_color(t.dim).child("asleep"))
    )
    .when(Boolean(spaceLabel), (el) =>
      el.child(div().pl(21).truncate().text_size(11).text_color(t.dim).child(spaceLabel))
    );
}

export function agentIcon(view, a, t) {
  return !a.program?.icon
    ? svg("icons/agent.svg").size(13).flex_none().text_color(t.foreground)
    : a.program.tint
      ? svg(a.program.icon).size(13).flex_none().text_color(t.foreground)
      : image(a.program.icon).size(13).flex_none();
}

export function renderActivityAgent(view, a, spaceLabel, t, now) {
  const dur = elapsed(now - (view.since.get(a.address)?.at ?? now));

  return v_flex()
    .id(`activity-agent-${a.address}`)
    .px(8)
    .py(5)
    .gap(2)
    .rounded(6)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click(() => run("pane.focus", { pane: a.pane }))
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(view.agentIcon(a, t))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.program?.name ?? a.app ?? ""))
        .child(div().flex_none().text_color(t[a.status] ?? t.unknown).child(a.status ?? ""))
        .when(Boolean(dur), (el) => el.child(div().flex_none().text_color(t.dim).child(dur)))
    )
    .when(Boolean(spaceLabel), (el) =>
      el.child(div().pl(21).truncate().text_size(11).text_color(t.dim).child(spaceLabel))
    );
}
