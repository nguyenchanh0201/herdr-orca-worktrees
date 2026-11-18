import { View, div } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme, closeOverlay, props, shared, setShared, checking, home, exec } from "herdr";
import config from "./config.js";
import { popupRow, subRow, renderAdd, renderHeader, renderOptions } from "./menu.view.js";
import { renderRename, renderIcon, renderClone } from "./dialogs.view.js";
import { renderSpace } from "./space.view.js";
import { appIconEl, renderOpenIn, renderApps } from "./apps.view.js";
import { renderGroup, renderNewGroup } from "./groups.view.js";

function defaultCloneName(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const seg = trimmed.split(/[/:]/).pop() || "";
  return seg.replace(/\.git$/i, "");
}

export default class OrcaProject extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    if (checking() || !props()?.overlay) return;

    const p = props();
    this.mode = p.mode ?? "add";
    this.closed = false;
    this.backMode = null;
    this.openInFolder = p.folder ?? null;
    this.handle.focus();

    if (this.mode === "open-in" || this.mode === "apps") {
      this.loadApps(cx);
    } else if (this.mode === "new-group") {
      this.localError = "";
      this.groupInput = InputState.new({ value: p.name ? `${p.name} group` : "" });
      this.groupInput.on("change", (_e, cx) => { this.localError = ""; cx.notify(); });
      this.groupInput.on("submit", (_e, cx) => this.submitNewGroup(cx));
      this.groupInput.focus();
    } else if (this.mode === "space") {
      this.sleepReqId = null;
      this.busyAgents = null;
      this.sleepError = null;
      cx.timer.every(150, (cx) => {
        if (this.closed || !this.sleepReqId) return;
        const s = shared("orca.projects.sleep");
        if (s?.id !== this.sleepReqId) return;
        if (s.state === "confirm") {
          if (!this.busyAgents) {
            this.busyAgents = Array.isArray(s.busy) ? s.busy : [];
            cx.notify();
          }
          return;
        }
        if (s.state === "running" || s.state === "done") {
          this.close();
          return;
        }
        if (s.state === "error") {
          this.sleepError = s.error ?? "Sleep failed";
          this.sleepReqId = null;
          cx.notify();
        }
      });
    } else if (this.mode === "icon") {
      this.localError = "";
      this.working = false;
      this.iconInput = InputState.new({ placeholder: "Path or URL to a PNG, JPEG or WebP, up to 256 KB" });
      this.iconInput.on("change", (_e, cx) => { this.localError = ""; cx.notify(); });
      this.iconInput.on("submit", (_e, cx) => this.submitIcon(cx, "custom"));
      this.iconInput.focus();
    } else if (this.mode === "rename") {
      this.localError = "";
      this.nameInput = InputState.new({ value: p.name ?? "" });
      this.nameInput.on("change", (_e, cx) => { this.localError = ""; cx.notify(); });
      this.nameInput.on("submit", (_e, cx) => this.submitRename(cx));
      this.nameInput.focus();
    } else if (this.mode === "clone") {
      let savedParent = "";
      try {
        savedParent = localStorage.getItem("clone.parent") || "";
      } catch {}

      this.userHome = home();
      this.parentEdited = false;
      this.nameEdited = false;
      this.suppressNameChange = false;
      this.focusedField = "url";
      this.reqId = null;
      this.lastCloneState = null;
      this.lastCloneError = null;
      this.localError = "";
      this.closed = false;

      this.urlInput = InputState.new({ placeholder: "https://github.com/org/repo.git" });
      this.parentInput = InputState.new({ value: savedParent || this.userHome, placeholder: "Parent folder" });
      this.nameInput = InputState.new({ placeholder: "repo" });

      this.urlInput.on("focus", (_e, cx) => { this.focusedField = "url"; cx.notify(); });
      this.parentInput.on("focus", (_e, cx) => { this.focusedField = "parent"; cx.notify(); });
      this.nameInput.on("focus", (_e, cx) => { this.focusedField = "name"; cx.notify(); });

      this.urlInput.on("change", (_e, cx) => {
        this.localError = "";
        if (!this.nameEdited) {
          this.suppressNameChange = true;
          this.nameInput.set_value(defaultCloneName(this.urlInput.value()));
          this.suppressNameChange = false;
        }
        cx.notify();
      });
      this.parentInput.on("change", (_e, cx) => {
        this.parentEdited = true;
        this.localError = "";
        cx.notify();
      });
      this.nameInput.on("change", (_e, cx) => {
        if (!this.suppressNameChange) {
          this.nameEdited = true;
        }
        this.localError = "";
        cx.notify();
      });

      this.urlInput.on("submit", (_e, cx) => this.submitClone(cx));
      this.parentInput.on("submit", (_e, cx) => this.submitClone(cx));
      this.nameInput.on("submit", (_e, cx) => this.submitClone(cx));

      this.urlInput.focus();

      if (!savedParent) {
        cx.spawn(async (cx) => {
          try {
            const res = await exec("test", ["-d", `${this.userHome}/jimmy_dev`]);
            if (res.code === 0 && !this.parentEdited) {
              this.parentInput.set_value(`${this.userHome}/jimmy_dev`);
              cx.notify();
            }
          } catch {}
        });
      }

      cx.timer.every(150, (cx) => {
        if (this.closed || !this.reqId) return;
        const c = shared("orca.projects.clone");
        if (c?.id !== this.reqId) return;
        if (c.state === "done") {
          this.closed = true;
          closeOverlay(props().overlay);
          return;
        }
        if (c.state !== this.lastCloneState || c.error !== this.lastCloneError) {
          this.lastCloneState = c.state;
          this.lastCloneError = c.error ?? null;
          cx.notify();
        }
      });
    }
  }

  loadApps(cx) {
    this.appsInstalled = [];
    this.appsChosen = new Set();
    cx.spawn(async (cx) => {
      try {
        const res = await exec(config.node, [config.cli, "apps", "list"]);
        const parsed = JSON.parse(res.stdout || "{}");
        if (Array.isArray(parsed.installed)) this.appsInstalled = parsed.installed;
        if (Array.isArray(parsed.chosen)) this.appsChosen = new Set(parsed.chosen);
      } catch {}
      cx.notify();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  isRunning() {
    if (!this.reqId) return false;
    const c = shared("orca.projects.clone");
    return c?.id === this.reqId && c.state === "running";
  }

  submitClone(cx) {
    if (this.isRunning()) return;
    const url = this.urlInput.value().trim();
    const parent = this.parentInput.value().trim();
    const name = this.nameInput.value().trim();

    if (!url) {
      this.localError = "Git URL is required.";
      cx.notify();
      return;
    }
    if (!parent) {
      this.localError = "Parent folder is required.";
      cx.notify();
      return;
    }
    if (!name) {
      this.localError = "Folder name is required.";
      cx.notify();
      return;
    }

    this.localError = "";
    try {
      localStorage.setItem("clone.parent", parent);
    } catch {}

    this.reqId = Date.now();
    this.lastCloneState = "running";
    this.lastCloneError = null;
    setShared("orca.projects.clone", { id: this.reqId, state: "running" });
    setShared("orca.projects.request", { id: this.reqId, kind: "clone", url, parent, name });
    cx.notify();
  }

  popupRow(id, label, onClick, t) { return popupRow(this, id, label, onClick, t); }

  subRow(id, label, onOpen, t) { return subRow(this, id, label, onOpen, t); }

  openOpenIn(folder, cx) {
    this.backMode = this.mode;
    this.openInFolder = folder;
    this.mode = "open-in";
    this.loadApps(cx);
    cx.notify();
  }

  openGroupMenu(cx) {
    this.backMode = this.mode;
    this.mode = "group";
    cx.notify();
  }

  renderAdd(t) { return renderAdd(this, t); }

  renderHeader(t) { return renderHeader(this, t); }

  submitRename(cx) {
    const p = props();
    const value = this.nameInput.value();
    cx.spawn(async (cx) => {
      try {
        const res = await exec(config.node, [config.cli, "projects", "rename", p.path, value]);
        const result = JSON.parse(res.stdout);
        if (result.error) {
          this.localError = result.error;
          cx.notify();
          return;
        }
        setShared("orca.projects.rev", Date.now());
        this.close();
      } catch (e) {
        this.localError = String(e);
        cx.notify();
      }
    });
  }

  renderRename(t) { return renderRename(this, t); }

  submitIcon(cx, source) {
    if (this.working) return;
    const args = [config.cli, "projects", "set-icon", props().path, source];
    if (source === "custom") args.push(this.iconInput.value());
    this.working = true;
    this.localError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await exec(config.node, args, { timeout: 30000 });
        const result = JSON.parse(res.stdout);
        if (result.error) {
          this.localError = result.error;
        } else {
          setShared("orca.projects.rev", Date.now());
          this.close();
        }
      } catch (e) {
        this.localError = String(e);
      } finally {
        this.working = false;
        cx.notify();
      }
    });
  }

  renderIcon(t) { return renderIcon(this, t); }

  renderOptions(t) { return renderOptions(this, t); }

  renderClone(t) { return renderClone(this, t); }

  renderSpace(t) { return renderSpace(this, t); }

  appIconEl(app, t) { return appIconEl(this, app, t); }

  renderOpenIn(t) { return renderOpenIn(this, t); }

  renderApps(t) { return renderApps(this, t); }

  renderGroup(t) { return renderGroup(this, t); }

  async submitNewGroup(cx) {
    const p = props();
    const raw = this.groupInput.value().trim();
    if (!raw) return;
    const groups = Array.isArray(p.groups) ? p.groups : [];
    if (groups.some((g) => typeof g === "string" && g.trim().toLowerCase() === raw.toLowerCase())) {
      this.localError = "A group with that name already exists — use Move to group";
      cx.notify();
      return;
    }
    try {
      const res = await exec(config.node, [config.cli, "projects", "set-group", p.path, raw]);
      const parsed = JSON.parse(res.stdout || "{}");
      if (parsed?.error) {
        this.localError = parsed.error;
        cx.notify();
        return;
      }
    } catch (err) {
      this.localError = err?.message ?? String(err);
      cx.notify();
      return;
    }
    setShared("orca.projects.rev", Date.now());
    this.close();
  }

  renderNewGroup(t) { return renderNewGroup(this, t); }

  render() {
    if (!props()?.overlay) return div();
    const t = theme();
    if (this.mode === "clone") return this.renderClone(t);
    if (this.mode === "rename") return this.renderRename(t);
    if (this.mode === "icon") return this.renderIcon(t);
    if (this.mode === "header") return this.renderHeader(t);
    if (this.mode === "options") return this.renderOptions(t);
    if (this.mode === "space") return this.renderSpace(t);
    if (this.mode === "open-in") return this.renderOpenIn(t);
    if (this.mode === "apps") return this.renderApps(t);
    if (this.mode === "group") return this.renderGroup(t);
    if (this.mode === "new-group") return this.renderNewGroup(t);
    return this.renderAdd(t);
  }
}
