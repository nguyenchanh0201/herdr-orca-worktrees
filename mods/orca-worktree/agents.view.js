import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Select, Popup } from "gpui-base";

export const TERMINAL_KEY = "__terminal__";

export function renderAgentIcon(view, agent, t) {
  if (!agent) {
    return svg("icons/shell.svg").size(14).flex_none().text_color(t.foreground);
  }
  if (!agent.icon || agent.tint) {
    return svg(agent.icon || "icons/agent.svg").size(14).flex_none().text_color(t.foreground);
  }
  return image(agent.icon).size(14).flex_none();
}

export function renderAgentField(view, running, t) {
  const installed = view.agents.filter((a) => a.installed);
  const chosen =
    view.selectedAgentKey === TERMINAL_KEY
      ? null
      : installed.find((a) => a.key === view.selectedAgentKey) ?? null;

  const trigger = h_flex()
    .id("agent-trigger")
    .w_full()
    .h(30)
    .px(10)
    .gap(8)
    .items_center()
    .rounded(6)
    .border(1)
    .border_color(view.agentOpen ? t.accent : t.input)
    .bg(t.background)
    .text_color(t.foreground)
    .cursor_pointer()
    .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => {
      if (running) return;
      view.agentOpen = !view.agentOpen;
      view.projectOpen = false;
      view.baseOpen = false;
      cx.notify();
    })
    .child(view.renderAgentIcon(chosen, t))
    .child(div().flex_1().truncate().child(chosen ? chosen.name : "Terminal"))
    .child(div().flex_none().text_color(t.dim).text_size(11).child("⇕"));

  const options = [
    { key: TERMINAL_KEY, name: "Terminal", agent: null },
    ...installed.map((a) => ({ key: a.key, name: a.name, agent: a })),
  ];

  const popupList = v_flex()
    .w(528)
    .max_h(200)
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .p(4)
    .overflow_y_scrollbar()
    .children(
      options.map((opt) => {
        const active = opt.key === view.selectedAgentKey;
        return h_flex()
          .id(`agent-opt-${opt.key}`)
          .h(28)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.selected))
          .on_click((_e, cx) => {
            view.agentOpen = false;
            view.agentTouched = true;
            view.selectedAgentKey = opt.key;
            cx.notify();
          })
          .child(div().w(14).flex_none().text_color(t.accent).child(active ? "✓" : ""))
          .child(view.renderAgentIcon(opt.agent, t))
          .child(div().flex_1().truncate().text_color(t.foreground).child(opt.name));
      })
    );

  return v_flex()
    .gap(5)
    .child(div().text_size(12).text_color(t.muted).child("Agent"))
    .child(
      Select.new("worktree-agent-select")
        .accessibility_label("Agent")
        .open(view.agentOpen)
        .track_focus(view.agentTriggerFocus)
        .content_focus_handle(view.agentListFocus)
        .on_open_change((open, cx) => {
          view.agentOpen = open;
          cx.notify();
        })
        .child(
          Popup.new("worktree-agent-popup", trigger)
            .anchor("bottom_left")
            .when(view.agentOpen, (el) => el.content(popupList))
        )
    );
}
