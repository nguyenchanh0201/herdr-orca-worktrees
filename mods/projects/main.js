import { View, div } from "gpui-kit";
import { v_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, machines, agents, setAgentOrder, exec, theme, checking, layout, shared, setShared, knownAgents } from "herdr";
import { placeOf, group, visibleRows, label, agentsBySpace, activitySort, hideMainRows, projectGroups } from "./group.js";
import { agentKind } from "./sleep.js";
import { findNode } from "./sidebar.js";
import config from "./config.js";
import { renderTopHeader, renderGroupHeader, renderHeader } from "./header.view.js";
import { renderRow, chipBadge, renderCard } from "./rows.view.js";
import { sleepingAgentIcon, renderSleepingAgent, renderActivitySleepingAgent, agentIcon, renderActivityAgent } from "./agents.view.js";
import { loadSleeping, handleSleep } from "./sleep-flow.view.js";
import { handleWake } from "./wake-flow.view.js";
import { check, pump } from "./sync.view.js";

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
    this.agentsOpen = new Set();
    try {
      const raw = localStorage.getItem("projects.agentsOpen");
      if (raw) this.agentsOpen = new Set(JSON.parse(raw));
    } catch {}
    this.view = "projects";
    try {
      const v = localStorage.getItem("projects.view");
      if (v === "activity" || v === "projects") this.view = v;
    } catch {}
    this.options = { sort: "added", hideMain: false };
    try {
      const raw = localStorage.getItem("projects.options");
      if (raw) {
        const parsed = JSON.parse(raw);
        this.options = {
          sort: parsed?.sort === "name" ? "name" : "added",
          hideMain: Boolean(parsed?.hideMain),
        };
      }
    } catch {}
    this.lastOptionsAt = null;
    this.groupKeys = [];
    this.scroll = ScrollHandle.new();
    this.lastActive = null;
    this.since = new Map();
    this.sig = "";
    this.reposSig = "";
    this.side = { seenWide: false, hidden: null };
    this.saved = [];
    this.logins = [];
    this.resolvedOnce = false;
    this.hoverHeader = null;
    this.seeded = null;
    this.sleepingByWorktree = {};
    this.knownAgentByKind = new Map();
    this.spaceIdsSig = "";
    this.sleepLoadSeq = 0;
    this.sleepLoadedOnce = false;
    this.waking = new Set();
    this.rev = shared("orca.projects.rev") ?? null;
    this.handledRequest = shared("orca.projects.request")?.id ?? null;

    if (checking()) return;

    setShared("orca.projects.options", this.options);
    cx.spawn(async (cx) => {
      const r = await this.cli(["projects", "logins"]);
      if (Array.isArray(r.logins)) this.logins = r.logins;
      cx.notify();
    });
    this.loadSaved(cx);
    this.loadKnownAgents(cx);
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
          if (!this.resolvedOnce && this.saved.some((s) => s.iconSource === null)) {
            this.resolvedOnce = true;
            // Its own spawn: downloads can take seconds and must not hold back the list or sleeping rows.
            cx.spawn(async (cx) => {
              const resolved = await this.cli(["projects", "resolve-icons"], 60000);
              if (Array.isArray(resolved.projects)) this.saved = resolved.projects;
              cx.notify();
            });
          }
        }
      } catch {
        this.saved = [];
        this.seeded = true;
      }
      if (!this.sleepLoadedOnce) {
        const primaries = this.currentRepoPrimaries();
        if (primaries.length > 0) {
          this.sleepLoadedOnce = true;
          this.loadSleeping(cx, primaries);
        }
      }
      cx.notify();
    });
  }

  loadKnownAgents(cx) {
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on: null });
        const map = new Map();
        for (const prog of list ?? []) {
          const cmd = prog?.run?.[0]?.split(/[/\\]/).pop();
          const kind =
            agentKind({ app: prog?.key, program: prog }) ??
            agentKind({ app: cmd }) ??
            (cmd === "dsh" ? "dsh" : null);
          if (kind && !map.has(kind)) {
            map.set(kind, prog);
          }
        }
        this.knownAgentByKind = map;
        cx.notify();
      } catch {}
    });
  }

  currentRepoPrimaries() {
    const set = new Set();
    for (const s of this.saved) {
      if (s?.path) set.add(s.path);
    }
    for (const r of this.repo.values()) {
      if (r?.primary) set.add(r.primary);
    }
    return [...set];
  }

  loadSleeping(cx, primaries = this.currentRepoPrimaries()) { return loadSleeping(this, cx, primaries); }

  async handleSleep(q, cx) { return handleSleep(this, q, cx); }

  async handleWake(q, cx) { return handleWake(this, q, cx); }

  check(cx) { return check(this, cx); }

  pump(cx) { return pump(this, cx); }

  saveCollapsed() {
    try {
      localStorage.setItem("projects.collapsed", JSON.stringify([...this.collapsed]));
    } catch {}
  }

  renderTopHeader(targetRepo, t) { return renderTopHeader(this, targetRepo, t); }

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

    let targetRepo = null;
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
          sleeping: this.sleepingByWorktree,
        }
      );

      const repos = groups
        .filter((g) => g.kind === "repo")
        .map((g) => ({ key: g.key, name: g.name, primary: g.primary }));
      const reposSig = JSON.stringify(repos);
      if (reposSig !== this.reposSig) {
        this.reposSig = reposSig;
        setShared("orca.projects.repos", repos);
      }

      const currentIds = new Set(sps.map((s) => s.id));
      for (const id of this.keyOf.keys()) {
        if (!currentIds.has(id)) this.keyOf.delete(id);
      }
      for (const g of groups) {
        for (const row of g.rows) {
          if (row.space) this.keyOf.set(row.space.id, g.key);
        }
      }

      const activeRepoGroup =
        groups.find((g) => g.kind === "repo" && g.rows.some((r) => r.space?.active)) ??
        groups.find((g) => g.kind === "repo");
      targetRepo = activeRepoGroup?.primary ?? null;
      this.groupKeys = groups.map((g) => g.key);

      if (this.view === "activity") {
        const now = Date.now();
        const sorted = activitySort(agents(), this.since);
        const spaceById = new Map(sps.map((s) => [s.id, s]));
        setAgentOrder(sorted.map((a) => a.address));
        const sleepingEntries = [];
        for (const g of groups) {
          for (const row of g.rows) {
            if (!row.sleeping) continue;
            const rowLabel = label(row, this.logins);
            for (const sa of row.sleeping.agents ?? []) {
              sleepingEntries.push({ sa, row, rowLabel });
            }
          }
        }
        if (sorted.length === 0 && sleepingEntries.length === 0) {
          body = v_flex().flex_1().min_h(0).items_center().justify_center()
            .child(div().text_color(t.muted).child("No agents"));
        } else {
          const children = sorted.map((a) => {
            const sp = spaceById.get(a.space);
            return this.renderActivityAgent(a, sp ? label(sp, this.logins) : "", t, now);
          });
          for (let i = 0; i < sleepingEntries.length; i++) {
            const { sa, row, rowLabel } = sleepingEntries[i];
            children.push(this.renderActivitySleepingAgent(sa, row, rowLabel, t, i));
          }
          body = v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar().track_scroll(this.scroll)
            .children(children);
        }
      } else if (groups.length === 0 && sps.length === 0) {
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

        let displayGroups = groups;
        if (this.options.hideMain) {
          displayGroups = hideMainRows(displayGroups);
        }

        const savedOrder = new Map(this.saved.map((s, i) => [s.path, i]));
        const sections = projectGroups(displayGroups, this.options.sort, savedOrder);
        const groupNames = sections.filter((s) => Boolean(s.name)).map((s) => s.name);
        for (const section of sections) {
          const isGroup = Boolean(section.key);
          const groupCollapsed = isGroup && this.collapsed.has(section.key);
          if (isGroup) {
            children.push(this.renderGroupHeader(section, groupCollapsed, t, children.length === 0));
          }
          for (const g of section.projects) {
            if (groupCollapsed && !g.rows.some((r) => Boolean(r.space?.active))) {
              continue;
            }
            const isCollapsed = groupCollapsed || this.collapsed.has(g.key);
            children.push(this.renderHeader(g, isCollapsed, t, children.length === 0, isGroup, groupNames));
            const rows = visibleRows(g, isCollapsed);
            for (const row of rows) {
              if (row.space?.active) {
                activeIndex = children.length;
              }
              const rowAgents = row.space ? (bySpace.get(row.space.id) ?? []) : [];
              const sleepingAgents = row.sleeping ? (row.sleeping.agents ?? []) : [];
              const hasAgents = rowAgents.some((a) => agentKind(a) !== null);
              const worktree = row.worktree ?? (row.space ? placeOf(row.space, ps) : "");
              if (!row.sleeping && row.space) {
                for (const a of rowAgents) {
                  order.push(a.address);
                }
              }
              children.push(this.renderCard(row, rowAgents, sleepingAgents, t, now, { hasAgents, worktree, indented: isGroup }));
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
      .child(this.renderTopHeader(targetRepo, t))
      .child(body);
  }

  toggleCollapsed(key, cx) {
    if (this.collapsed.has(key)) {
      this.collapsed.delete(key);
    } else {
      this.collapsed.add(key);
    }
    try {
      localStorage.setItem("projects.collapsed", JSON.stringify([...this.collapsed]));
    } catch {}
    cx.notify();
  }

  renderGroupHeader(section, isCollapsed, t, first = false) { return renderGroupHeader(this, section, isCollapsed, t, first); }

  renderHeader(g, isCollapsed, t, first = false, indented = false, groupNames = []) { return renderHeader(this, g, isCollapsed, t, first, indented, groupNames); }

  renderRow(row, t, opts = {}) { return renderRow(this, row, t, opts); }

  chipBadge(text, t) { return chipBadge(this, text, t); }

  toggleAgents(worktree, cx) {
    if (!worktree) return;
    if (this.agentsOpen.has(worktree)) this.agentsOpen.delete(worktree);
    else this.agentsOpen.add(worktree);
    try {
      localStorage.setItem("projects.agentsOpen", JSON.stringify([...this.agentsOpen]));
    } catch {}
    cx.notify();
  }

  renderCard(row, rowAgents, sleepingAgents, t, now, opts = {}) { return renderCard(this, row, rowAgents, sleepingAgents, t, now, opts); }

  sleepingAgentIcon(sa, t) { return sleepingAgentIcon(this, sa, t); }

  renderSleepingAgent(sa, row, t, idx) { return renderSleepingAgent(this, sa, row, t, idx); }

  renderActivitySleepingAgent(sa, row, spaceLabel, t, idx) { return renderActivitySleepingAgent(this, sa, row, spaceLabel, t, idx); }

  agentIcon(a, t) { return agentIcon(this, a, t); }

  renderActivityAgent(a, spaceLabel, t, now) { return renderActivityAgent(this, a, spaceLabel, t, now); }
}
