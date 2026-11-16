import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, machines, agents, setAgentOrder, run, openOverlay, exec, theme, checking, layout, shared, setShared, pickFolder, notify } from "herdr";
import { placeOf, group, visibleRows, label, agentsBySpace, sinceUpdate, elapsed } from "./group.js";
import { findNode, sidebarStep } from "./sidebar.js";
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
    this.since = new Map();
    this.sig = "";
    this.side = { seenWide: false, hidden: null };
    this.saved = [];
    this.seeded = null;
    this.rev = shared("orca.projects.rev") ?? null;
    this.handledRequest = shared("orca.projects.request")?.id ?? null;

    if (checking()) return;

    this.loadSaved(cx);
    cx.timer.every(500, (cx) => this.check(cx));
    this.check(cx);
  }

  async cli(args, timeout) {
    try {
      const res = await exec(config.node, [config.cli, ...args], timeout ? { timeout } : undefined);
      const parsed = JSON.parse(res.stdout || "{}");
      if (res.code !== 0 && !parsed.error) {
        return { error: (res.stderr || res.stdout || `exit ${res.code}`).trim() };
      }
      return parsed;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  loadSaved(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await this.cli(["projects", "list"]);
        if (r.error) {
          this.saved = [];
          this.seeded = true;
        } else {
          this.saved = Array.isArray(r.projects) ? r.projects : [];
          this.seeded = Boolean(r.seeded);
        }
      } catch {
        this.saved = [];
        this.seeded = true;
      }
      cx.notify();
    });
  }

  check(cx) {
    if (checking()) return;
    const r = sidebarStep(findNode(layout(), "sidebar"), this.side, shared("sidebar.width"));
    this.side = r.state;
    if (r.resize !== null) {
      run("layout.resize", { id: "sidebar", px: r.resize });
      setShared("sidebar.collapsed", false);
    }
    if (r.hide) run("layout.hide", { id: "sidebar" });
    if (r.hide || r.hiddenChanged) setShared("orca.sidebar.hidden", this.side.hidden);

    const rev = shared("orca.projects.rev");
    if (rev !== undefined && rev !== this.rev) {
      this.rev = rev;
      this.loadSaved(cx);
    }

    const q = shared("orca.projects.request");
    if (q?.id && q.id !== this.handledRequest) {
      this.handledRequest = q.id;
      cx.spawn(async () => {
        if (q.kind === "pick") {
          const f = await pickFolder({ prompt: "Add project" });
          if (!f) return;
          const res = await this.cli(["projects", "add", f]);
          if (res.error) {
            notify({ title: "Add project", body: res.error, level: "error" });
          } else {
            const name = (res.path || f).split("/").filter(Boolean).pop() || f;
            notify({ title: "Project added", body: name });
            setShared("orca.projects.rev", Date.now());
          }
        } else if (q.kind === "clone") {
          setShared("orca.projects.clone", { id: q.id, state: "running" });
          const res = await this.cli(["clone", q.url, q.parent, q.name], 600000);
          if (res.error) {
            setShared("orca.projects.clone", { id: q.id, state: "error", error: res.error });
            notify({ title: "Clone failed", body: res.error, level: "error" });
          } else {
            setShared("orca.projects.clone", { id: q.id, state: "done" });
            notify({ title: "Project added", body: q.name });
            setShared("orca.projects.rev", Date.now());
          }
        }
      });
    }

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
    const ag = agents();
    this.since = sinceUpdate(this.since, ag, now);
    const nextSig = sps.map((s) => `${s.id}=${placeOf(s, ps)}`).join(";")
      + `|active=${activeId}`
      + `|agents=${ag.map((a) => `${a.address}:${a.status}`).join(",")}`
      + `|min=${Math.floor(now / 60000)}`;

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

    if (this.seeded === false && this.startDone && this.inflight.size === 0 && this.queue.length === 0) {
      this.seeded = true;
      const groups = group(
        sps,
        (s) => placeOf(s, ps),
        (p) => (p ? this.repo.get(p) : null),
        {
          prevKeyOf: (id) => this.keyOf.get(id),
          giveUp: (id) => this.seenAt.has(id) && now - this.seenAt.get(id) >= 1000,
          saved: this.saved,
        }
      );
      const primaries = groups.filter((g) => g.kind === "repo").map((g) => g.primary);
      cx.spawn(async () => {
        await this.cli(["projects", "seed", ...primaries]);
        setShared("orca.projects.rev", Date.now());
      });
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
    if ((findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160) {
      return div().size_full().bg(t.chrome);
    }
    const sps = spaces();
    const ps = panes();

    const localMachine = machines().find((m) => m.name === null);
    const ready = localMachine?.layout === "ready";
    const loading = !ready || (Date.now() - this.startedAt < 3000 && this.inflight.size + this.queue.length > 0);

    const addRow = h_flex()
      .id("add-project-btn")
      .h(28)
      .px(12)
      .gap(6)
      .items_center()
      .flex_none()
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() =>
        openOverlay({
          mod: "orca-project",
          kind: "popup",
          width: 220,
          height: 90,
          props: { mode: "add" },
        })
      )
      .child("+")
      .child("Add project");

    let body;
    if (loading) {
      body = v_flex().flex_1().min_h(0).items_center().justify_center()
        .child(div().text_color(t.muted).child("Loading…"));
    } else {
      const groups = group(
        sps,
        (s) => placeOf(s, ps),
        (p) => (p ? this.repo.get(p) : null),
        {
          prevKeyOf: (id) => this.keyOf.get(id),
          giveUp: (id) => this.seenAt.has(id) && Date.now() - this.seenAt.get(id) >= 1000,
          saved: this.saved,
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

      if (groups.length === 0 && sps.length === 0) {
        body = v_flex().flex_1().min_h(0).items_center().justify_center()
          .child(div().text_color(t.muted).child("No spaces"));
      } else {
        const now = Date.now();
        const bySpace = agentsBySpace(agents());
        const order = [];
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
            for (const a of bySpace.get(row.space.id) ?? []) {
              order.push(a.address);
              children.push(this.renderAgent(a, t, now));
            }
          }
        }

        if (activeId !== this.lastActive) {
          this.lastActive = activeId;
          if (activeIndex >= 0) {
            this.scroll.scroll_to_item(activeIndex);
          }
        }

        setAgentOrder(order);

        body = v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(children);
      }
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(body)
      .child(addRow);
  }

  renderHeader(g, isCollapsed, t) {
    const missing = g.kind === "repo" && g.exists === false;
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
      .when(g.kind === "repo", (el) =>
        el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "orca-project",
            kind: "popup",
            width: 220,
            height: 80,
            props: { mode: "header", path: g.primary, saved: Boolean(g.saved) },
          });
        })
      )
      .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
      .child(div().flex_initial().truncate().text_color(missing ? t.dim : t.foreground).font_bold().child(g.name))
      .child(div().flex_none().text_color(t.muted).child(String(g.rows.length)))
      .child(div().flex_1());

    if (missing) {
      head.child(div().flex_none().text_size(11).text_color(t.dim).child("missing"));
    } else if (g.kind === "repo") {
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
              mod: "orca-new",
              kind: "popup",
              width: 250,
              height: 260,
              props: { folder: g.primary },
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

  renderAgent(a, t, now) {
    const icon = !a.program?.icon
      ? svg("icons/agent.svg").size(13).flex_none().text_color(t.foreground)
      : a.program.tint
        ? svg(a.program.icon).size(13).flex_none().text_color(t.foreground)
        : image(a.program.icon).size(13).flex_none();
    const dur = elapsed(now - (this.since.get(a.address)?.at ?? now));

    return h_flex()
      .id(`agent-${a.address}`)
      .h(24)
      .pl(24)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(a.program?.name ?? a.app ?? ""))
      .child(div().flex_none().text_color(t[a.status] ?? t.unknown).child(a.status ?? ""))
      .when(Boolean(dur), (el) => el.child(div().flex_none().text_color(t.dim).child(dur)));
  }
}
