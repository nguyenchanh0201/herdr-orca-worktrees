import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, shared, setShared, checking, pickFolder, home, exec } from "herdr";
import config from "./config.js";

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
    this.handle.focus();

    if (this.mode === "space") {
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

  popupRow(id, label, onClick, t) {
    return h_flex()
      .id(id)
      .h(31)
      .px(9)
      .rounded(7)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .text_color(t.foreground)
      .hover((s) => s.bg(t.selected))
      .on_click(onClick)
      .child(div().flex_1().child(label));
  }

  renderAdd(t) {
    return v_flex()
      .id("orca-project-add")
      .w_full()
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      })
      .child(
        this.popupRow(
          "choose-folder",
          "Choose folder…",
          () => {
            setShared("orca.projects.request", { id: Date.now(), kind: "pick" });
            this.close();
          },
          t
        )
      )
      .child(
        this.popupRow(
          "clone-url",
          "Clone from URL…",
          () => {
            this.close();
            openOverlay({
              mod: "orca-project",
              kind: "dialog",
              width: 520,
              height: 230,
              props: { mode: "clone" },
            });
          },
          t
        )
      );
  }

  renderHeader(t) {
    const p = props();
    return v_flex()
      .id("orca-project-header")
      .w_full()
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      })
      .when(Boolean(p.saved), (el) =>
        el.child(
          this.popupRow("rename-project", "Rename…", () => {
            this.close();
            openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 160,
              props: { mode: "rename", path: p.path, name: p.name } });
          }, t)
        ).child(
          this.popupRow("change-project-icon", "Change icon…", () => {
            this.close();
            openOverlay({ mod: "orca-project", kind: "dialog", width: 420, height: 260,
              props: { mode: "icon", path: p.path } });
          }, t)
        ).child(
          this.popupRow(
            "remove-project",
            "Remove from sidebar",
            async () => {
              await exec(config.node, [config.cli, "projects", "remove", p.path]);
              setShared("orca.projects.rev", Date.now());
              this.close();
            },
            t
          )
        )
      )
      .when(!p.saved, (el) =>
        el.child(
          div()
            .px(9)
            .py(6)
            .text_color(t.dim)
            .child("Not saved — it shows while its spaces are open")
        )
      );
  }

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

  renderRename(t) {
    return v_flex()
      .id("orca-project-rename")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.close(); }
      })
      .size_full().p(12).gap(6).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("Rename project"))
      .child(Input.new(this.nameInput).h(30).px(10).items_center().rounded(6)
        .border(1).border_color(t.accent).bg(t.background).text_color(t.foreground))
      .child(div().text_size(12).text_color(t.muted).child("Leave empty to use the folder name"))
      .when(Boolean(this.localError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.localError)))
      .child(h_flex().justify_end().child(
        div().id("save-project-name").h(30).px(14).flex().items_center().rounded(6)
          .bg(t.accent).text_color(t.background).font_semibold().cursor_pointer()
          .on_click((_e, cx) => this.submitRename(cx)).child("Save")
      ));
  }

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

  renderIcon(t) {
    return v_flex()
      .id("orca-project-icon")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.close(); }
      })
      .size_full().p(12).gap(6).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("Project icon"))
      .child(this.popupRow("icon-github", "GitHub avatar", (_e, cx) => this.submitIcon(cx, "github"), t))
      .child(this.popupRow("icon-repo", "Icon from repo", (_e, cx) => this.submitIcon(cx, "repo"), t))
      .child(this.popupRow("icon-letter", "Letter", (_e, cx) => this.submitIcon(cx, "letter"), t))
      .child(div().text_color(t.muted).child("Custom…"))
      .child(h_flex().gap(8).child(
        Input.new(this.iconInput).flex_1().h(30).px(10).items_center().rounded(6)
          .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).disabled(this.working)
      ).child(
        div().id("apply-project-icon").h(30).px(14).flex().items_center().rounded(6)
          .bg(t.accent).text_color(t.background).font_semibold().cursor_pointer().disabled(this.working)
          .on_click((_e, cx) => this.submitIcon(cx, "custom")).child("Apply")
      ))
      .when(this.working, (el) => el.child(div().text_color(t.muted).child("Working…")))
      .when(Boolean(this.localError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.localError)));
  }

  renderOptions(t) {
    const cur = shared("orca.projects.options") ?? {};
    const divider = () => div().h(1).my(4).mx(6).bg(t.border);
    const checkRow = (id, label, checked, onClick) =>
      h_flex()
        .id(id)
        .h(31)
        .px(9)
        .rounded(7)
        .items_center()
        .flex_none()
        .cursor_pointer()
        .text_color(t.foreground)
        .hover((s) => s.bg(t.selected))
        .on_click(onClick)
        .child(div().flex_1().child(label))
        .child(div().w(16).flex_none().text_color(t.accent).child(checked ? "✓" : ""));

    return v_flex()
      .id("orca-project-options")
      .w_full()
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      })
      .child(
        this.popupRow(
          "collapse-all-projects",
          "Collapse all projects",
          () => {
            setShared("orca.projects.options", { ...cur, collapse: "all", at: Date.now() });
            this.close();
          },
          t
        )
      )
      .child(
        this.popupRow(
          "expand-all-projects",
          "Expand all projects",
          () => {
            setShared("orca.projects.options", { ...cur, collapse: "none", at: Date.now() });
            this.close();
          },
          t
        )
      )
      .child(divider())
      .child(
        div()
          .px(9)
          .py(4)
          .text_size(11)
          .font_semibold()
          .text_color(t.muted)
          .child("Sort projects")
      )
      .child(
        checkRow("sort-added", "Order added", cur.sort !== "name", (_e, cx) => {
          setShared("orca.projects.options", { sort: "added", hideMain: Boolean(cur.hideMain), at: Date.now() });
          cx.notify();
        })
      )
      .child(
        checkRow("sort-name", "Name", cur.sort === "name", (_e, cx) => {
          setShared("orca.projects.options", { sort: "name", hideMain: Boolean(cur.hideMain), at: Date.now() });
          cx.notify();
        })
      )
      .child(divider())
      .child(
        checkRow("hide-main", "Hide main checkouts", Boolean(cur.hideMain), (_e, cx) => {
          setShared("orca.projects.options", { sort: cur.sort ?? "added", hideMain: !cur.hideMain, at: Date.now() });
          cx.notify();
        })
      );
  }

  renderClone(t) {
    const clone = this.reqId ? shared("orca.projects.clone") : null;
    const activeClone = clone?.id === this.reqId ? clone : null;
    const running = activeClone?.state === "running";
    const err = this.localError || (activeClone?.state === "error" ? activeClone.error : "");

    const inputStyle = (state, focused, flex1 = false) =>
      Input.new(state)
        .h(30)
        .px(10)
        .items_center()
        .rounded(6)
        .border(1)
        .border_color(focused ? t.accent : t.input)
        .bg(t.background)
        .text_color(t.foreground)
        .disabled(running)
        .when(flex1, (el) => el.flex_1());

    return v_flex()
      .id("orca-project-clone")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          this.close();
        }
      })
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("Clone from URL"))
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().w(96).flex_none().text_color(t.muted).child("Git URL"))
          .child(inputStyle(this.urlInput, this.focusedField === "url", true))
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().w(96).flex_none().text_color(t.muted).child("Parent folder"))
          .child(inputStyle(this.parentInput, this.focusedField === "parent", true))
          .child(
            div()
              .id("choose-parent")
              .flex_none()
              .h(30)
              .px(10)
              .flex()
              .items_center()
              .rounded(6)
              .border(1)
              .border_color(t.input)
              .bg(t.background)
              .text_color(running ? t.dim : t.foreground)
              .cursor_pointer()
              .disabled(running)
              .when(!running, (el) => el.hover((s) => s.bg(t.hover)))
              .on_click((_e, cx) => {
                if (running) return;
                cx.spawn(async (cx) => {
                  const f = await pickFolder({ prompt: "Choose parent folder" });
                  if (f) {
                    this.parentEdited = true;
                    this.parentInput.set_value(f);
                    this.localError = "";
                    cx.notify();
                  }
                });
              })
              .child("Choose…")
          )
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().w(96).flex_none().text_color(t.muted).child("Folder name"))
          .child(inputStyle(this.nameInput, this.focusedField === "name", true))
      )
      .when(Boolean(err), (el) => el.child(div().text_size(12).text_color(t.blocked).child(err)))
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(
            div()
              .id("cancel-clone")
              .h(30)
              .px(12)
              .flex()
              .items_center()
              .rounded(6)
              .border(1)
              .border_color(t.input)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Cancel")
          )
          .child(
            div()
              .id("submit-clone")
              .h(30)
              .px(14)
              .flex()
              .items_center()
              .rounded(6)
              .bg(running ? t.hover : t.accent)
              .text_color(running ? t.muted : t.background)
              .font_semibold()
              .cursor_pointer()
              .disabled(running)
              .on_click((_e, cx) => this.submitClone(cx))
              .child(running ? "Cloning…" : "Clone")
          )
      );
  }

  renderSpace(t) {
    const p = props();
    const wrap = v_flex()
      .id("orca-project-space")
      .w_full()
      .bg(t.popover)
      .p(5)
      .text_size(12.8)
      .track_focus(this.handle)
      .on_key_down((e) => {
        if (e.key === "escape") this.close();
      });

    if (this.busyAgents) {
      const msg =
        this.busyAgents.length === 1
          ? `${this.busyAgents[0].name} is ${this.busyAgents[0].status === "blocked" ? "waiting for you" : "working"}. Sleep anyway?`
          : `${this.busyAgents.map((b) => b.name).join(", ")} are busy. Sleep anyway?`;

      return wrap
        .p(10)
        .gap(10)
        .child(div().text_size(12.4).text_color(t.foreground).child(msg))
        .child(
          h_flex()
            .justify_end()
            .gap(6)
            .child(
              div()
                .id("sleep-cancel")
                .h(28)
                .px(10)
                .flex()
                .items_center()
                .rounded(6)
                .border(1)
                .border_color(t.input)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => this.close())
                .child("Cancel")
            )
            .child(
              div()
                .id("sleep-confirm")
                .h(28)
                .px(10)
                .flex()
                .items_center()
                .rounded(6)
                .bg(t.accent)
                .text_color(t.background)
                .font_semibold()
                .cursor_pointer()
                .on_click(() => {
                  const id = Date.now();
                  this.sleepReqId = id;
                  setShared("orca.projects.request", { id, kind: "sleep", space: p.space, confirm: true });
                  this.close();
                })
                .child("Sleep anyway")
            )
        );
    }

    return wrap
      .when(Boolean(p.hasAgents && !p.sleeping && p.space), (el) =>
        el.child(
          this.popupRow(
            "space-sleep",
            "Sleep",
            (_e, cx) => {
              if (this.sleepReqId) return;
              this.sleepReqId = Date.now();
              this.sleepError = null;
              setShared("orca.projects.request", { id: this.sleepReqId, kind: "sleep", space: p.space, confirm: false });
              cx.notify();
            },
            t
          )
        )
      )
      .when(Boolean(p.sleeping), (el) =>
        el.child(
          this.popupRow(
            "space-wake",
            "Wake",
            () => {
              setShared("orca.projects.request", { id: Date.now(), kind: "wake", worktree: p.worktree });
              this.close();
            },
            t
          )
        )
      )
      .when(Boolean(p.sleeping && !p.space), (el) =>
        el.child(
          this.popupRow(
            "space-forget-sleep",
            "Forget sleep",
            () => {
              setShared("orca.projects.request", { id: Date.now(), kind: "forget-sleep", worktree: p.worktree });
              this.close();
            },
            t
          )
        )
      )
      .when(Boolean(p.space), (el) =>
        el.child(
          this.popupRow(
            "space-menu",
            "Space menu…",
            () => {
              this.close();
              openOverlay({
                mod: "menu",
                kind: "popup",
                width: 200,
                height: 260,
                props: { tab: "space", target: { id: p.space } },
              });
            },
            t
          )
        )
      )
      .when(Boolean(this.sleepError), (el) =>
        el.child(div().px(9).py(4).text_size(11).text_color(t.blocked).child(this.sleepError))
      );
  }

  render() {
    if (!props()?.overlay) return div();
    const t = theme();
    if (this.mode === "clone") return this.renderClone(t);
    if (this.mode === "rename") return this.renderRename(t);
    if (this.mode === "icon") return this.renderIcon(t);
    if (this.mode === "header") return this.renderHeader(t);
    if (this.mode === "options") return this.renderOptions(t);
    if (this.mode === "space") return this.renderSpace(t);
    return this.renderAdd(t);
  }
}
