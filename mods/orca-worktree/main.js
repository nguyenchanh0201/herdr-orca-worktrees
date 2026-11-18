import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Button } from "gpui-base";
import { theme, closeOverlay, props, shared, setShared, checking, knownAgents, exec, home, appHome, readTextFile } from "herdr";
import config from "./config.js";
import { TERMINAL_KEY, renderAgentIcon, renderAgentField } from "./agents.view.js";
import { renderProjectField } from "./project.view.js";
import { renderBaseField, renderNameField } from "./branches.view.js";

const KNOWN = "new-menu.agents";

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
    return renderAgentIcon(this, agent, t);
  }

  renderProjectField(repos, running, t) {
    return renderProjectField(this, repos, running, t);
  }

  renderBaseField(running, t) {
    return renderBaseField(this, running, t);
  }

  renderNameField(running, t) {
    return renderNameField(this, running, t);
  }

  renderAgentField(running, t) {
    return renderAgentField(this, running, t);
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
