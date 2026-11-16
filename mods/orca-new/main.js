import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, openOverlay, closeOverlay, props, shared, setShared, checking } from "herdr";

// Same cache key and shape as new-menu so cached local agents appear immediately.
const KNOWN = "new-menu.agents";

export default class OrcaNew extends View {
  init(_p, cx) {
    this.agents = shared(KNOWN)?.[""] ?? [];
    this.failed = false;
    this.handle = cx.focus_handle();

    if (checking() || !props()?.overlay) return;

    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        const agents = await knownAgents({ on: null });
        this.agents = agents;
        setShared(KNOWN, { ...shared(KNOWN), "": agents });
      } catch {
        this.failed = true;
      }
      cx.notify();
    });
  }

  choose(agent) {
    const { overlay, folder } = props();
    closeOverlay(overlay);
    const worktreeProps = agent
      ? { folder, machine: null, action: "new", argv: agent.run, tab: agent.name }
      : { folder, machine: null, action: "new" };
    openOverlay({
      mod: "worktree",
      kind: "dialog",
      width: 460,
      height: 280,
      props: worktreeProps,
    });
  }

  row(id, icon, name, onClick, hint = "") {
    const t = theme();
    return h_flex()
      .id(id)
      .h(31)
      .px(9)
      .gap(10)
      .rounded(7)
      .items_center()
      .flex_none()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.selected))
      .on_click(onClick)
      .child(icon)
      .child(div().flex_1().child(name))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    // Only meaningful as the `+` popup; a docked copy (no overlay) draws nothing.
    if (!props()?.overlay) return div();
    const t = theme();
    const installed = this.agents.filter((a) => a.installed);

    return v_flex()
      .min_h(0)
      .w_full()
      .h(
        Math.min(
          260,
          74 +
            Math.max(
              1,
              installed.length + (this.failed || this.agents.length === 0 ? 1 : 0)
            ) *
              31
        )
      )
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .id("orca-new")
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        this.choose(agent);
      })
      .child(
        this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () =>
          this.choose(null)
        )
      )
      .child(div().px(9).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(
            installed.map((a, i) =>
              this.row(
                a.key,
                !a.icon || a.tint
                  ? svg(a.icon || "icons/agent.svg").size(14).text_color(t.foreground)
                  : image(a.icon).size(14),
                a.name,
                () => this.choose(a),
                i < 9 ? String(i + 1) : ""
              )
            )
          )
          .when(this.failed || this.agents.length === 0, (el) =>
            el.child(
              div()
                .px(9)
                .py(6)
                .text_color(t.dim)
                .child(
                  this.failed
                    ? "Could not check installed agents"
                    : "Checking installed agents…"
                )
            )
          )
      );
  }
}
