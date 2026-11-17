import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Select, Popup, Button, Scrollbar } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, shared, setShared, checking, knownAgents, exec, home, appHome, readTextFile } from "herdr";
import config from "./config.js";

const KNOWN = "new-menu.agents";
const TERMINAL_KEY = "__terminal__";

async function worktreeRoot() {
  const raw = await readTextFile(`${appHome()}/settings.json`);
  const directory = (raw === null ? {} : JSON.parse(raw))?.worktrees?.directory ?? "~/.herdr/worktrees";
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("worktrees.directory must be a non-empty path.");
  }
  let p = directory.replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) {
    p = home().replace(/\\/g, "/").replace(/\/$/, "") + p.slice(1);
  }
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) {
    throw new Error("worktrees.directory must be an absolute path or start with ~/.");
  }
  return p.replace(/\/+$/, "");
}

function basename(p) {
  return (p || "").split("/").filter(Boolean).pop() || p || "";
}

function loadSavedAgent() {
  try {
    return localStorage.getItem("agent.last") || "";
  } catch {
    return "";
  }
}

function saveAgent(key) {
  try {
    localStorage.setItem("agent.last", key);
  } catch {}
}

function isBaseOpen(base, branchData) {
  if (!base || !branchData) return false;
  const localSet = new Set(branchData.local ?? []);
  const remote = branchData.remote ?? [];
  const isRemoteBase = remote.includes(base) && !localSet.has(base);
  const target = isRemoteBase ? base.slice(base.indexOf("/") + 1) : base;
  if (isRemoteBase && !localSet.has(target)) return false;
  return Boolean((branchData.checkedOut ?? {})[target]);
}

function hintFor(name, base, branchData) {
  if (!base) return "";
  const trimmed = (name || "").trim();
  if (trimmed) return `New branch ${trimmed} from ${base}`;

  const local = branchData?.local ?? [];
  const remote = branchData?.remote ?? [];
  const checkedOut = branchData?.checkedOut ?? {};
  const localSet = new Set(local);
  const isRemoteBase = remote.includes(base) && !localSet.has(base);
  let targetBranch = base;
  if (isRemoteBase) {
    const short = base.slice(base.indexOf("/") + 1);
    if (!localSet.has(short)) {
      return `Checks out ${short} tracking ${base}`;
    }
    targetBranch = short;
  }
  if (checkedOut[targetBranch]) {
    const sug = branchData?.suggested || "new-branch";
    return `New branch ${sug} from ${base}`;
  }
  return `Opens ${base}`;
}

export default class OrcaWorktree extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.projectTriggerFocus = cx.focus_handle();
    this.projectListFocus = cx.focus_handle();
    this.baseTriggerFocus = cx.focus_handle();
    this.baseListFocus = cx.focus_handle();
    this.agentTriggerFocus = cx.focus_handle();
    this.agentListFocus = cx.focus_handle();

    if (checking() || !props()?.overlay) return;

    this.closed = false;
    this.projectOpen = false;
    this.baseOpen = false;
    this.agentOpen = false;
    this.baseHighlight = 0;

    const repos = shared("orca.projects.repos") ?? [];
    this.repo = props()?.repo || repos[0]?.primary || "";
    this.base = "";
    this.branchData = null;
    this.branchesLoading = false;
    this.branchesError = "";
    this.branchesLoadSeq = 0;

    this.agents = shared(KNOWN)?.[""] ?? [];
    this.agentTouched = false;
    this.selectedAgentKey = this.pickDefaultAgentKey(this.agents);

    this.reqId = null;
    this.lastWorktreeState = null;
    this.lastWorktreeError = null;
    this.localError = "";

    this.nameInput = InputState.new({ placeholder: "" });
    this.nameFocused = false;
    this.nameInput.on("focus", (_e, cx) => {
      this.nameFocused = true;
      cx.notify();
    });
    this.nameInput.on("blur", (_e, cx) => {
      this.nameFocused = false;
      cx.notify();
    });
    this.nameInput.on("change", (_e, cx) => {
      this.localError = "";
      cx.notify();
    });
    this.nameInput.on("submit", (_e, cx) => this.submit(cx));

    this.baseSearchInput = InputState.new({ placeholder: "Search branches…" });
    this.baseSearchInput.on("change", (_e, cx) => {
      this.baseHighlight = 0;
      cx.notify();
    });

    if (this.repo) {
      this.loadBranches(this.repo, cx);
    }

    cx.spawn(async (cx) => {
      try {
        const agents = await knownAgents({ on: null });
        this.agents = agents;
        setShared(KNOWN, { ...shared(KNOWN), "": agents });
        if (!this.agentTouched) {
          this.selectedAgentKey = this.pickDefaultAgentKey(agents);
        }
        cx.notify();
      } catch {}
    });

    this.nameInput.focus();

    cx.timer.every(150, (cx) => {
      if (this.closed || !this.reqId) return;
      const w = shared("orca.projects.worktree");
      if (w?.id !== this.reqId) return;
      if (w.state === "done") {
        saveAgent(this.selectedAgentKey);
        this.close();
        return;
      }
      if (w.state !== this.lastWorktreeState || w.error !== this.lastWorktreeError) {
        this.lastWorktreeState = w.state;
        this.lastWorktreeError = w.error ?? null;
        cx.notify();
      }
    });
  }

  pickDefaultAgentKey(agents) {
    const saved = loadSavedAgent();
    if (saved && saved !== TERMINAL_KEY) {
      const found = (agents ?? []).find((a) => a.installed && a.key === saved);
      if (found) return found.key;
    }
    return TERMINAL_KEY;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  isRunning() {
    if (!this.reqId) return false;
    const w = shared("orca.projects.worktree");
    return w?.id === this.reqId && w.state === "running";
  }

  loadBranches(repo, cx) {
    const seq = ++this.branchesLoadSeq;
    this.branchesLoading = true;
    this.branchesError = "";
    this.branchData = null;
    this.base = "";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const root = await worktreeRoot();
        const res = await exec(config.node, [config.cli, "branches", repo, "--root", root]);
        if (seq !== this.branchesLoadSeq || this.closed) return;
        const parsed = JSON.parse(res.stdout || "{}");
        if (res.code !== 0 && !parsed.error) {
          this.branchesError = (res.stderr || res.stdout || `exit ${res.code}`).trim();
        } else if (parsed.error) {
          this.branchesError = parsed.error;
        } else {
          this.branchData = parsed;
          this.base = parsed.default || parsed.local?.[0] || parsed.remote?.[0] || "";
        }
      } catch (e) {
        if (seq !== this.branchesLoadSeq || this.closed) return;
        this.branchesError = String(e?.message ?? e);
      } finally {
        if (seq === this.branchesLoadSeq && !this.closed) {
          this.branchesLoading = false;
          cx.notify();
        }
      }
    });
  }

  filteredBranches() {
    const query = this.baseSearchInput.value().trim().toLowerCase();
    const local = (this.branchData?.local ?? []).filter((b) => b.toLowerCase().includes(query));
    const remote = (this.branchData?.remote ?? []).filter((b) => b.toLowerCase().includes(query));
    const items = [
      ...local.map((name) => ({ kind: "local", name })),
      ...remote.map((name) => ({ kind: "remote", name })),
    ];
    return { local, remote, items };
  }

  selectBase(name, cx) {
    this.base = name;
    this.baseOpen = false;
    this.localError = "";
    this.nameInput.focus();
    cx.notify();
  }

  submit(cx) {
    if (this.isRunning() || this.branchesLoading) return;
    if (!this.repo) {
      this.localError = "Select a project first.";
      cx.notify();
      return;
    }
    if (!this.base) {
      this.localError = "Select a base branch.";
      cx.notify();
      return;
    }
    this.localError = "";
    const installed = this.agents.filter((a) => a.installed);
    const agent =
      this.selectedAgentKey === TERMINAL_KEY
        ? null
        : installed.find((a) => a.key === this.selectedAgentKey) ?? null;

    this.reqId = Date.now();
    this.lastWorktreeState = "running";
    this.lastWorktreeError = null;
    setShared("orca.projects.worktree", { id: this.reqId, state: "running" });
    setShared("orca.projects.request", {
      id: this.reqId,
      kind: "worktree",
      repo: this.repo,
      base: this.base,
      name: this.nameInput.value().trim(),
      agent: agent ? { name: agent.name, run: agent.run } : null,
    });
    cx.notify();
  }

  renderAgentIcon(agent, t) {
    if (!agent) {
      return svg("icons/shell.svg").size(14).flex_none().text_color(t.foreground);
    }
    if (!agent.icon || agent.tint) {
      return svg(agent.icon || "icons/agent.svg").size(14).flex_none().text_color(t.foreground);
    }
    return image(agent.icon).size(14).flex_none();
  }

  renderProjectField(repos, running, t) {
    const selectedRepo = repos.find((r) => r.primary === this.repo) ?? repos[0] ?? null;
    if (!this.repo && selectedRepo) {
      this.repo = selectedRepo.primary;
    }

    const trigger = h_flex()
      .id("project-trigger")
      .flex_1()
      .h(30)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(this.projectOpen ? t.accent : t.input)
      .bg(t.background)
      .text_color(selectedRepo ? t.foreground : t.dim)
      .cursor_pointer()
      .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        if (running) return;
        this.projectOpen = !this.projectOpen;
        this.baseOpen = false;
        this.agentOpen = false;
        cx.notify();
      })
      .child(div().flex_1().truncate().child(selectedRepo ? selectedRepo.name : "No projects"))
      .child(div().flex_none().text_color(t.dim).text_size(11).child("⇕"));

    const popupList = v_flex()
      .w(340)
      .max_h(220)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(8)
      .p(4)
      .overflow_y_scrollbar()
      .children(
        repos.map((r) => {
          const active = r.primary === this.repo;
          return h_flex()
            .id(`proj-opt-${r.key}`)
            .h(28)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.selected))
            .on_click((_e, cx) => {
              this.projectOpen = false;
              if (r.primary !== this.repo) {
                this.repo = r.primary;
                this.localError = "";
                this.loadBranches(r.primary, cx);
              } else {
                cx.notify();
              }
            })
            .child(div().w(14).flex_none().text_color(t.accent).child(active ? "✓" : ""))
            .child(div().flex_1().truncate().text_color(t.foreground).child(r.name));
        })
      )
      .when(repos.length === 0, (el) =>
        el.child(div().px(8).py(6).text_color(t.dim).child("No projects available"))
      );

    return v_flex()
      .gap(5)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(12).text_color(t.muted).child("Project"))
          .child(
            h_flex()
              .id("worktree-add-project")
              .w(22)
              .h(22)
              .items_center()
              .justify_center()
              .rounded(5)
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
              .child(svg("mods/workspace-chrome/folder-plus.svg").size(14))
          )
      )
      .child(
        Select.new("worktree-project-select")
          .accessibility_label("Project")
          .open(this.projectOpen)
          .track_focus(this.projectTriggerFocus)
          .content_focus_handle(this.projectListFocus)
          .on_open_change((open, cx) => {
            this.projectOpen = open;
            cx.notify();
          })
          .child(
            Popup.new("worktree-project-popup", trigger)
              .anchor("bottom_left")
              .when(this.projectOpen, (el) => el.content(popupList))
          )
      );
  }

  renderBaseField(running, t) {
    const { local, remote, items } = this.filteredBranches();
    const localSet = new Set(this.branchData?.local ?? []);
    const checkedOut = this.branchData?.checkedOut ?? {};
    const defaultBranch = this.branchData?.default ?? "";

    const triggerLabel = this.branchesLoading
      ? "Loading branches…"
      : this.base || (this.branchesError ? "Failed to load branches" : "Select branch");

    const trigger = h_flex()
      .id("base-trigger")
      .w_full()
      .h(30)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(this.baseOpen ? t.accent : t.input)
      .bg(t.background)
      .text_color(this.base ? t.foreground : t.dim)
      .cursor_pointer()
      .when(!running && !this.branchesLoading, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        if (running || this.branchesLoading) return;
        this.baseOpen = !this.baseOpen;
        this.projectOpen = false;
        this.agentOpen = false;
        if (this.baseOpen) {
          this.baseSearchInput.set_value("");
          const idx = items.findIndex((it) => it.name === this.base);
          this.baseHighlight = idx >= 0 ? idx : 0;
          this.baseSearchInput.focus();
        }
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().truncate().child(triggerLabel))
      .child(div().flex_none().text_color(t.dim).text_size(11).child("⇕"));

    const renderBranchRow = (name, isRemote, flatIdx) => {
      const selected = name === this.base;
      const highlighted = flatIdx === this.baseHighlight;
      const isDefault = name === defaultBranch;
      const short = isRemote ? name.slice(name.indexOf("/") + 1) : name;
      const remoteOnly = isRemote && !localSet.has(short);
      const openPath = !remoteOnly ? checkedOut[short] : null;

      let note = "";
      if (isDefault) note = "(default)";
      if (openPath) note = `${note ? `${note} ` : ""}· open in ${basename(openPath)}`;
      else if (remoteOnly) note = `checks out as ${short}`;

      return h_flex()
        .id(`branch-opt-${isRemote ? "r" : "l"}-${name}`)
        .h(28)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(highlighted, (el) => el.bg(t.selected))
        .when(!highlighted, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.selectBase(name, cx))
        .child(div().w(14).flex_none().text_color(t.accent).child(selected ? "✓" : ""))
        .child(div().flex_initial().truncate().text_color(t.foreground).child(name))
        .when(Boolean(note), (el) =>
          el.child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(note))
        );
    };

    let flatIdx = 0;
    const listChildren = [];
    if (local.length > 0) {
      listChildren.push(
        div().px(8).pt(6).pb(2).text_size(11).font_semibold().text_color(t.dim).child("Local")
      );
      for (const name of local) {
        listChildren.push(renderBranchRow(name, false, flatIdx++));
      }
    }
    if (remote.length > 0) {
      listChildren.push(
        div().px(8).pt(8).pb(2).text_size(11).font_semibold().text_color(t.dim).child("Remote")
      );
      for (const name of remote) {
        listChildren.push(renderBranchRow(name, true, flatIdx++));
      }
    }
    if (listChildren.length === 0) {
      listChildren.push(div().px(8).py(10).text_color(t.dim).child("No matching branches"));
    }

    const popupContent = v_flex()
      .w(528)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(8)
      .p(6)
      .gap(6)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.baseOpen = false;
          this.baseTriggerFocus.focus();
          cx.notify();
          return;
        }
        const n = items.length;
        if (e.key === "down" && n > 0) {
          cx.stop_propagation();
          this.baseHighlight = (this.baseHighlight + 1) % n;
          cx.notify();
        } else if (e.key === "up" && n > 0) {
          cx.stop_propagation();
          this.baseHighlight = (this.baseHighlight + n - 1) % n;
          cx.notify();
        } else if (e.key === "enter" && n > 0) {
          cx.stop_propagation();
          const chosen = items[Math.min(this.baseHighlight, n - 1)];
          if (chosen) this.selectBase(chosen.name, cx);
        }
      })
      .child(
        Input.new(this.baseSearchInput)
          .h(28)
          .px(8)
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(t.input)
          .bg(t.background)
          .text_color(t.foreground)
      )
      .child(
        v_flex()
          .relative()
          .h(Math.min(220, Math.max(44, listChildren.length * 28)))
          .child(
            v_flex()
              .id("base-branch-list")
              .size_full()
              .overflow_y_scroll()
              .children(listChildren)
          )
          .child(Scrollbar.vertical("base-branch-list").absolute().inset_0())
      );

    return v_flex()
      .gap(5)
      .child(div().text_size(12).text_color(t.muted).child("Create From"))
      .child(
        Select.new("worktree-base-select")
          .accessibility_label("Create From")
          .open(this.baseOpen)
          .track_focus(this.baseTriggerFocus)
          .content_focus_handle(this.baseListFocus)
          .on_open_change((open, cx) => {
            this.baseOpen = open;
            if (open) {
              this.baseSearchInput.set_value("");
              const idx = items.findIndex((it) => it.name === this.base);
              this.baseHighlight = idx >= 0 ? idx : 0;
              this.baseSearchInput.focus();
            }
            cx.notify();
          })
          .child(
            Popup.new("worktree-base-popup", trigger)
              .anchor("bottom_left")
              .when(this.baseOpen, (el) => el.content(popupContent))
          )
      );
  }

  renderNameField(running, t) {
    const baseOpenInWorktree = isBaseOpen(this.base, this.branchData);
    const placeholder = baseOpenInWorktree
      ? this.branchData?.suggested || "New branch name (optional)"
      : "New branch name (optional)";
    const value = this.nameInput.value();
    const hint = hintFor(value, this.base, this.branchData);

    return v_flex()
      .gap(5)
      .child(div().text_size(12).text_color(t.muted).child("Branch name"))
      .child(
        div()
          .relative()
          .h(30)
          .rounded(6)
          .border(1)
          .border_color(this.nameFocused ? t.accent : t.input)
          .bg(t.background)
          .when(!value, (el) =>
            el.child(
              div()
                .absolute()
                .left(10)
                .right(10)
                .top(0)
                .bottom(0)
                .flex()
                .items_center()
                .text_color(t.dim)
                .truncate()
                .child(placeholder)
            )
          )
          .child(
            Input.new(this.nameInput)
              .size_full()
              .px(10)
              .items_center()
              .text_color(t.foreground)
              .disabled(running)
          )
      )
      .when(Boolean(hint), (el) =>
        el.child(div().text_size(11.5).text_color(t.muted).truncate().child(hint))
      );
  }

  renderAgentField(running, t) {
    const installed = this.agents.filter((a) => a.installed);
    const chosen =
      this.selectedAgentKey === TERMINAL_KEY
        ? null
        : installed.find((a) => a.key === this.selectedAgentKey) ?? null;

    const trigger = h_flex()
      .id("agent-trigger")
      .w_full()
      .h(30)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(6)
      .border(1)
      .border_color(this.agentOpen ? t.accent : t.input)
      .bg(t.background)
      .text_color(t.foreground)
      .cursor_pointer()
      .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => {
        if (running) return;
        this.agentOpen = !this.agentOpen;
        this.projectOpen = false;
        this.baseOpen = false;
        cx.notify();
      })
      .child(this.renderAgentIcon(chosen, t))
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
          const active = opt.key === this.selectedAgentKey;
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
              this.agentOpen = false;
              this.agentTouched = true;
              this.selectedAgentKey = opt.key;
              cx.notify();
            })
            .child(div().w(14).flex_none().text_color(t.accent).child(active ? "✓" : ""))
            .child(this.renderAgentIcon(opt.agent, t))
            .child(div().flex_1().truncate().text_color(t.foreground).child(opt.name));
        })
      );

    return v_flex()
      .gap(5)
      .child(div().text_size(12).text_color(t.muted).child("Agent"))
      .child(
        Select.new("worktree-agent-select")
          .accessibility_label("Agent")
          .open(this.agentOpen)
          .track_focus(this.agentTriggerFocus)
          .content_focus_handle(this.agentListFocus)
          .on_open_change((open, cx) => {
            this.agentOpen = open;
            cx.notify();
          })
          .child(
            Popup.new("worktree-agent-popup", trigger)
              .anchor("bottom_left")
              .when(this.agentOpen, (el) => el.content(popupList))
          )
      );
  }

  render() {
    if (!props()?.overlay) return div();
    const t = theme();
    const repos = shared("orca.projects.repos") ?? [];
    const w = this.reqId ? shared("orca.projects.worktree") : null;
    const activeW = w?.id === this.reqId ? w : null;
    const running = activeW?.state === "running";
    const disabled = running || this.branchesLoading;
    const err =
      this.localError ||
      this.branchesError ||
      (activeW?.state === "error" ? activeW.error : "");

    return v_flex()
      .id("orca-worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          if (this.baseOpen) {
            this.baseOpen = false;
            this.baseTriggerFocus.focus();
            cx.notify();
          } else if (this.projectOpen) {
            this.projectOpen = false;
            this.projectTriggerFocus.focus();
            cx.notify();
          } else if (this.agentOpen) {
            this.agentOpen = false;
            this.agentTriggerFocus.focus();
            cx.notify();
          } else {
            this.close();
          }
        } else if (e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) {
          cx.stop_propagation();
          this.submit(cx);
        }
      })
      .size_full()
      .p(16)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().font_semibold().text_size(14).text_color(t.foreground).child("Create worktree"))
          .child(
            div()
              .id("close-worktree-dialog")
              .w(24)
              .h(24)
              .flex()
              .items_center()
              .justify_center()
              .rounded(5)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child(svg("mods/workspace-chrome/x.svg").size(14))
          )
      )
      .child(this.renderProjectField(repos, running, t))
      .child(this.renderBaseField(running, t))
      .child(this.renderNameField(running, t))
      .child(this.renderAgentField(running, t))
      .child(div().flex_1())
      .when(Boolean(err), (el) =>
        el.child(div().text_size(12).text_color(t.blocked).child(err))
      )
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(
            Button.new("create-worktree-btn")
              .h(32)
              .px(14)
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .bg(disabled ? t.hover : t.solid)
              .text_color(disabled ? t.muted : t.solid_foreground)
              .font_semibold()
              .cursor_pointer()
              .disabled(disabled)
              .on_click((_e, cx) => this.submit(cx))
              .child(running ? "Creating…" : "Create ⌘↵")
          )
      );
  }
}
