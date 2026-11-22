import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, setShared, openOverlay } from "herdr";
import { navigationChild } from "./navigation.view.js";
import { label, agentSummary, topStatus, STATUS_GLYPH, elapsed } from "./group.js";

export function renderRow(view, row, t, opts = {}) {
  const space = row.space;
  const sleeping = Boolean(row.sleeping);
  const hasAgents = Boolean(opts.hasAgents);
  const worktree = opts.worktree ?? row.worktree ?? "";
  const dot = sleeping
    ? svg("orca-icons/moon.svg").size(13).flex_none().text_color(t.dim)
    : space?.status
      ? div().flex_none().text_color(t[space.status] ?? t.unknown).child("●")
      : div().flex_none().text_color(t.dim).child("●");

  const rowEl = h_flex()
    .id(space ? `space-${space.id}` : `sleep-${row.worktree}`)
    .h(28)
    .pl(8)
    .pr(8)
    .gap(6)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .when(sleeping, (el) =>
      el.on_click(() => {
        if (space) run("space.select", { id: space.id });
        if (worktree) {
          setShared("orca.projects.request", { id: Date.now(), kind: "wake", worktree });
        }
      })
    )
    .when(!sleeping && Boolean(space), (el) =>
      el.on_click(() => run("space.select", { id: space.id }))
    )
    .on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({
        mod: "orca-project",
        kind: "popup",
        width: 220,
        height: 240,
        props: {
          mode: "space",
          space: space ? space.id : null,
          worktree,
          folder: worktree,
          sleeping,
          hasAgents,
        },
      });
    })
    // Fixed-width slot so every worktree name lines up, whatever the glyph.
    .child(h_flex().w(12).flex_none().justify_center().child(dot))
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_color(sleeping ? t.dim : t.foreground)
        .child(label(row, view.logins))
    );

  if (row.main) {
    rowEl.child(view.chipBadge("main", t));
  }
  if (space?.machine) {
    rowEl.child(view.chipBadge(space.machine, t));
  }

  return rowEl;
}

export function chipBadge(view, text, t) {
  return div()
    .flex_none()
    .border(1)
    .border_color(t.border)
    .rounded(4)
    .px(5)
    .text_size(11)
    .text_color(t.muted)
    .child(text);
}

export function renderCard(view, row, rowAgents, sleepingAgents, t, now, opts = {}) {
  const space = row.space;
  const active = Boolean(space?.active);
  const sleeping = Boolean(row.sleeping);
  const worktree = opts.worktree ?? row.worktree ?? "";
  const cardKey = space?.id ?? row.worktree ?? worktree;
  const foldKey = worktree ? (space?.machine ? `${space.machine}:${worktree}` : worktree) : cardKey;
  const live = !sleeping && space ? rowAgents : [];
  const sleepList = sleeping ? (sleepingAgents ?? []) : [];
  const count = sleeping ? sleepList.length : live.length;

  const card = v_flex()
    .id(`card-${cardKey}`)
    // Indented under the project and borderless, so projects → worktrees read as a tree.
    .ml(opts.indented ? 36 : 22)
    .p(2)
    .gap(2)
    .mb(2)
    .rounded(8)
    // The selected card gets Orca's outline; others keep an invisible one so selecting never shifts them.
    .border(1)
    .border_color(active ? t.border : "#00000000")
    .when(active, (el) => el.bg(t.selected))
    .when(!active, (el) => el.hover((s) => s.bg(t.hover)))
    .child(view.renderRow(row, t, opts));

  if (count === 0) return card;

  const open = Boolean(foldKey) && view.agentsOpen.has(foldKey);
  if (!open) {
    const { icons, more } = agentSummary(sleeping ? sleepList : live);
    const strip = h_flex()
      .id(`strip-${cardKey}`)
      .h(24)
      .ml(18)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .hover((s) => s.bg(t.hover))
      .cursor_pointer()
      .on_click((_e, cx) => view.toggleAgents(foldKey, cx));

    if (sleeping) {
      strip.child(svg("orca-icons/moon.svg").size(13).flex_none().text_color(t.dim));
      for (const sa of icons) {
        strip.child(view.sleepingAgentIcon(sa, t));
      }
    } else {
      const top = topStatus(live);
      strip.child(
        div()
          .flex_none()
          .text_color(top ? (t[top] ?? t.unknown) : t.unknown)
          .child(top ? STATUS_GLYPH[top] : "○")
      );
      for (const a of icons) {
        strip.child(view.agentIcon(a, t));
      }
    }

    if (more > 0) {
      strip.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${more}`));
    }
    strip.child(div().flex_1());
    strip.child(div().flex_none().text_color(t.dim).child("›"));
    return card.child(strip);
  }

  const head = h_flex()
    .id(`agents-head-${cardKey}`)
    .h(24)
    .px(8)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => view.toggleAgents(foldKey, cx))
    .child(div().flex_1().text_size(11).text_color(t.muted).child(`${count} agent${count === 1 ? "" : "s"}`))
    .child(div().flex_none().text_color(t.dim).child("⌄"));
  card.child(head);

  const agentScroll = view.agentScrolls.get(foldKey);
  const childRows = [];
  const register = (node, entry, i) => opts.navigation ? navigationChild(view, {
    ...entry, parent: opts.navigation.key, index: opts.navigation.index, agentScroll, agentIndex: i,
  }, node, t) : node;
  if (sleeping) {
    for (let i = 0; i < sleepList.length; i++) {
      childRows.push(register(view.renderSleepingAgent(sleepList[i], row, t, i), {
        key: `sleeping:${cardKey}:${i}:${sleepList[i].name ?? sleepList[i].kind}`, row, worktree,
      }, i));
    }
  } else {
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      const dur = elapsed(now - (view.since.get(a.address)?.at ?? now));
      const status = a.status ?? "";
      const statusLabel = status ? status[0].toUpperCase() + status.slice(1) : "Unknown";
      const name = a.program?.name ?? a.app ?? "";
      const labelText = name ? `${statusLabel} - ${name}` : statusLabel;
      childRows.push(register(
        h_flex()
          .id(`agent-${a.address}`)
          .h(24)
          .pl(16)
          .pr(8)
          .gap(6)
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", a.pane ? { pane: a.pane } : { terminal: a.address }))
          .child(div().flex_none().text_color(t[a.status] ?? t.unknown).child(STATUS_GLYPH[a.status] ?? "○"))
          .child(view.agentIcon(a, t))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(labelText))
          .when(Boolean(dur), (el) => el.child(div().flex_none().text_color(t.dim).child(dur))),
        { key: `agent:${a.address}`, agent: a }, i
      ));
    }
  }

  return card.child(v_flex().id(`agents-list-${cardKey}`).h(Math.min(168, count * 24)).min_h(0).overflow_y_scroll()
    .when(Boolean(agentScroll), el => el.track_scroll(agentScroll)).children(childRows));
}
