import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, machines, run, openOverlay, exec, theme, checking } from "herdr";
import { placeOf, group, visibleRows, label } from "./group.js";
import config from "./config.js";

export default class Projects extends View {
  init(_p, cx) {
    this.repo = new Map();
    this.inflight = new Set();
    this.queue = [];
    this.keyOf = new Map();
    this.seenAt = new Map();
    this.lastPlace = new Map();
    this.givenUp = new Set();
    this.startedAt = Date.now();
    this.startDone = false;
    this.collapsed = new Set();
    try {
      const raw = localStorage.getItem("projects.collapsed");
      if (raw) this.collapsed = new Set(JSON.parse(raw));
    } catch {}
    this.scroll = ScrollHandle.new();
    this.lastActive = null;
    this.sig = "";

    if (checking()) return;

    cx.timer.every(500, (cx) => this.check(cx));
    this.check(cx);
  }

  check(cx) {
    if (checking()) return;
    if (machines().find((m) => m.name === null)?.layout !== "ready") return;

    const sps = spaces();
    const ps = panes();
    const now = Date.now();
    const currentIds = new Set(sps.map((s) => s.id));

    for (const id of this.lastPlace.keys()) {
      if (!currentIds.has(id)) {
        this.lastPlace.delete(id);
        this.seenAt.delete(id);
        this.givenUp.delete(id);
      }
    }

    for (const s of sps) {
      if (s.machine !== null) continue;
      const place = placeOf(s, ps);

      if (!place) {
        this.seenAt.delete(s.id);
        this.givenUp.delete(s.id);
        this.lastPlace.set(s.id, "");
        continue;
      }

      const prevPlace = this.lastPlace.get(s.id);
      if (prevPlace !== place) {
        this.lastPlace.set(s.id, place);
        this.givenUp.delete(s.id);
        if (this.repo.has(place)) {
          this.seenAt.delete(s.id);
        } else {
          this.seenAt.set(s.id, now);
        }
      } else if (this.repo.has(place)) {
        this.seenAt.delete(s.id);
        this.givenUp.delete(s.id);
      }

      if (!this.repo.has(place) && !this.inflight.has(place) && !this.queue.includes(place)) {
        this.queue.push(place);
        if (!this.seenAt.has(s.id)) {
          this.seenAt.set(s.id, now);
        }
      }
    }

    this.pump(cx);

    const activeSpace = sps.find((s) => s.active);
    const activeId = activeSpace ? activeSpace.id : "";
    const nextSig = sps.map((s) => `${s.id}=${placeOf(s, ps)}`).join(";") + `|active=${activeId}`;

    let shouldNotify = false;
    if (nextSig !== this.sig) {
      this.sig = nextSig;
      shouldNotify = true;
    }

    for (const [id, t0] of this.seenAt) {
      if (now - t0 >= 1000 && !this.givenUp.has(id)) {
        this.givenUp.add(id);
        shouldNotify = true;
      }
    }

    if (!this.startDone && now - this.startedAt >= 3000) {
      this.startDone = true;
      shouldNotify = true;
    }

    if (shouldNotify) {
      cx.notify();
    }
  }

  pump(cx) {
    while (this.inflight.size < 6 && this.queue.length > 0) {
      const place = this.queue.shift();
      this.inflight.add(place);
      cx.spawn(async (cx) => {
        try {
          // shortcut: bare repos and submodules get a wrong primary from orca-wt info; fix gitInfo if one shows up.
          const res = await exec(config.node, [config.cli, "info", place]);
          if (res.code !== 0) {
            this.repo.set(place, null);
          } else {
            const r = JSON.parse(res.stdout || "{}");
            this.repo.set(place, r.error ? null : { primary: r.primary, linked: Boolean(r.linked) });
          }
        } catch {
          this.repo.set(place, null);
        } finally {
          this.inflight.delete(place);
          this.pump(cx);
          cx.notify();
        }
      });
    }
  }

  render() {
    const t = theme();
    const sps = spaces();
    const ps = panes();

    const localMachine = machines().find((m) => m.name === null);
    const ready = localMachine?.layout === "ready";
    const loading = !ready || (Date.now() - this.startedAt < 3000 && this.inflight.size + this.queue.length > 0);

    if (loading) {
      return v_flex().size_full().min_h(0).items_center().justify_center()
        .child(div().text_color(t.muted).child("Loading…"));
    }

    const groups = group(
      sps,
      (s) => placeOf(s, ps),
      (p) => (p ? this.repo.get(p) : null),
      {
        prevKeyOf: (id) => this.keyOf.get(id),
        giveUp: (id) => this.seenAt.has(id) && Date.now() - this.seenAt.get(id) >= 1000,
      }
    );

    const currentIds = new Set(sps.map((s) => s.id));
    for (const id of this.keyOf.keys()) {
      if (!currentIds.has(id)) this.keyOf.delete(id);
    }
    for (const g of groups) {
      for (const row of g.rows) {
        this.keyOf.set(row.space.id, g.key);
      }
    }

    if (sps.length === 0) {
      return v_flex().size_full().min_h(0).items_center().justify_center()
        .child(div().text_color(t.muted).child("No spaces"));
    }

    const children = [];
    let activeIndex = -1;
    const activeSpace = sps.find((s) => s.active);
    const activeId = activeSpace ? activeSpace.id : null;

    for (const g of groups) {
      const isCollapsed = this.collapsed.has(g.key);
      children.push(this.renderHeader(g, isCollapsed, t));
      const rows = visibleRows(g, isCollapsed);
      for (const row of rows) {
        if (row.space?.active) {
          activeIndex = children.length;
        }
        children.push(this.renderRow(row, t));
      }
    }

    if (activeId !== this.lastActive) {
      this.lastActive = activeId;
      if (activeIndex >= 0) {
        this.scroll.scroll_to_item(activeIndex);
      }
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(
        v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(children)
      );
  }

  renderHeader(g, isCollapsed, t) {
    const head = h_flex()
      .id(`project-header-${g.key}`)
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.collapsed.has(g.key)) {
          this.collapsed.delete(g.key);
        } else {
          this.collapsed.add(g.key);
        }
        try {
          localStorage.setItem("projects.collapsed", JSON.stringify([...this.collapsed]));
        } catch {}
        cx.notify();
      })
      .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
      .child(div().flex_initial().truncate().text_color(t.foreground).font_bold().child(g.name))
      .child(div().flex_none().text_color(t.muted).child(String(g.rows.length)))
      .child(div().flex_1());

    if (g.kind === "repo") {
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
              mod: "worktree",
              kind: "dialog",
              width: 460,
              height: 280,
              props: { folder: g.primary, machine: null, action: "new" },
            });
          })
          .child("+")
      );
    }

    return head;
  }

  renderRow(row, t) {
    const space = row.space;
    const dot = space.status
      ? div().flex_none().text_color(t[space.status] ?? t.unknown).child("●")
      : div().flex_none().text_color(t.dim).child("·");

    const rowEl = h_flex()
      .id(`space-${space.id}`)
      .h(28)
      .pl(12)
      .pr(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(space.active, (el) => el.bg(t.selected))
      .when(!space.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: space.id }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({
          mod: "menu",
          kind: "popup",
          width: 200,
          height: 260,
          props: { tab: "space", target: { id: space.id } },
        });
      })
      .child(dot)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(label(space)));

    if (row.main) {
      rowEl.child(div().flex_none().text_color(t.dim).child("★"));
    }

    return rowEl;
  }
}
