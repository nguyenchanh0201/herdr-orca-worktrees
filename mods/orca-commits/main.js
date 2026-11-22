import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, ScrollHandle, VirtualListScrollHandle, InputState, Input, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { theme, closeOverlay, props, checking, exec, focused, spaces, panes, run, nextCommand, shared, setShared } from "herdr";
import config from "./config.js";

const untab = (text) =>
  text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - ((s.length - 1) % 4) + 4));

function diffRows(text) {
  const lines = (text || "").replace(/\n$/, "").split("\n").filter(Boolean);
  let old = 0;
  let next = 0;
  let inHunk = false;
  return lines.map((line) => {
    if (line.startsWith("diff --git ")) inHunk = false;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      inHunk = true;
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (!inHunk) return { kind: "", text: line };
    if (kind === "-") return { kind, oldNumber: old, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, newNumber: next, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") {
      const oldNumber = old++;
      return { kind, oldNumber, newNumber: next, number: next++, text: untab(line.slice(1)) || " " };
    }
    return { kind: "", text: line };
  });
}

export default class OrcaCommits extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.commitScroll = ScrollHandle.new();
    this.fileScroll = ScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.sourceScrolls = Object.fromEntries(["Merge Changes", "Staged Changes", "Changes"].map(section => [section, ScrollHandle.new()]));
    this.panel = !props()?.overlay;
    this.folder = "";
    this.mode = props()?.mode || "changes";
    this.status = {};
    this.statusRequest = 0;
    this.busy = false;
    this.actionError = "";
    this.collapsed = {};
    this.drafts = {};
    this.message = InputState.new({ placeholder: "Message (i to focus · ⌘Enter to commit)" });
    this.message.on("focus", () => { this.editing = true; });
    this.message.on("blur", () => { this.editing = false; });
    this.message.on("change", (_e, cx) => { this.drafts[this.folder] = this.message.value(); cx.notify(); });
    this.editLoading = false;
    this.editRequest = 0;
    this.editorError = "";
    this.generation = 0;
    this.filesRequest = 0;
    this.diffRequest = 0;
    this.commits = [];
    this.files = [];
    this.loading = true;
    this.error = "";
    this.selected = null;
    this.selectedFile = null;
    this.selectedSection = null;
    this.filesLoading = false;
    this.filesError = "";
    this.diffRows = [];
    this.diffWidth = 0;
    this.diffLoading = false;
    this.diffError = "";
    this.lane = "commits";
    this.diffCursor = 0;
    this.count = "";
    this.lastG = 0;
    this.diffHeight = 300;
    this.height = 650;
    if (checking()) return;
    this.handle.focus();
    this.syncFolder(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "edit") this.openEditor(cx);
        if (command === "focus") { this.handle.focus(); cx.notify(); }
        const key = { next: "j", previous: "k", forward: "l", back: "h", first: "home", last: "G" }[command];
        if (key) this.keyDown({ key }, cx, false);
      }
    });
    if (this.panel) cx.timer.every(10000, (cx) => {
      this.syncFolder(cx);
      if (!this.loading && !this.busy) this.load(cx);
    });
  }

  syncFolder(cx) {
    const space = spaces().find(s => s.active);
    const f = focused();
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    const folder = props()?.folder || pane?.cwd || space?.folder || f?.cwd || "";
    if (this.contextSet && folder === this.folder) return;
    this.contextSet = true;
    this.leaveEditor();
    this.editorError = "";
    this.folder = folder;
    this.message.set_value(this.drafts[folder] || "");
    this.status = {};
    this.statusRequest++;
    this.actionError = "";
    this.generation++;
    this.filesRequest++;
    this.diffRequest++;
    this.commits = [];
    this.files = [];
    this.selected = null;
    this.selectedFile = null;
    this.selectedSection = null;
    this.diffRows = [];
    this.lane = this.mode === "changes" ? "files" : "commits";
    this.count = "";
    this.lastG = 0;
    this.commitScroll.scroll_to_item(0);
    this.load(cx);
  }

  async cli(args) {
    const r = await exec(config.node, [config.cli, ...args]);
    const parsed = JSON.parse((r.stdout || "").trim() || "{}");
    if (r.code !== 0 && !parsed.error) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
    return parsed;
  }

  dismiss() {
    if (this.panel) run("layout.hide", { id: "panel" });
    else closeOverlay(props().overlay);
  }

  load(cx) {
    if (this.mode === "changes") { this.loadStatus(cx); return; }
    const generation = this.generation;
    const folder = this.folder;
    this.loading = true;
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        const log = await this.cli(["commits", folder, "--limit", "100"]);
        if (generation !== this.generation) return;
        if (log.error) this.error = log.error;
        else {
          this.commits = log.commits ?? [];
          if (!this.selected || (this.selected !== "WORKING" && !this.commits.some(c => c.hash === this.selected))) {
            this.selected = "WORKING";
            this.selectedFile = null;
            this.selectedSection = null;
            this.files = [];
            this.diffRows = [];
            this.diffRequest++;
          }
        }
      } catch (e) {
        if (generation === this.generation) this.error = String(e?.message ?? e);
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          if (!this.error && this.selected) this.loadFiles(cx);
          cx.notify();
        }
      }
    });
  }

  select(key, cx) {
    if (this.selected === key) return;
    this.editorError = "";
    this.selected = key;
    this.selectedFile = null;
    this.selectedSection = null;
    this.files = [];
    this.diffRows = [];
    this.diffError = "";
    this.diffLoading = false;
    this.diffRequest++;
    this.fileScroll.scroll_to_item(0);
    this.loadFiles(cx);
  }

  loadFiles(cx) {
    const request = ++this.filesRequest;
    const key = this.selected;
    const folder = this.folder;
    this.filesLoading = true;
    this.filesError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await this.cli(["commit-files", folder, key]);
        if (request !== this.filesRequest) return;
        if (res.error) {
          this.filesError = res.error;
          this.files = [];
          this.selectFile(null, cx);
        } else {
          this.files = res.files ?? [];
          const file = this.files.find(f => f.path === this.selectedFile);
          if (!file) this.selectFile(this.lane === "files" ? this.files[0] : null, cx);
          else if (key === "WORKING") this.loadDiff(file, cx, false);
        }
      } catch (e) {
        if (request === this.filesRequest) this.filesError = String(e?.message ?? e);
      } finally {
        if (request === this.filesRequest) { this.filesLoading = false; cx.notify(); }
      }
    });
  }

  selectFile(file, cx) {
    this.selectedSection = null;
    this.leaveEditor();
    this.editorError = "";
    this.selectedFile = file?.path ?? null;
    this.selectedGroup = file?.group ?? null;
    this.diffRows = [];
    this.diffError = "";
    this.diffLoading = false;
    this.diffCursor = 0;
    this.diffRequest++;
    this.diffScroll.scroll_to_item(0);
    if (file) this.loadDiff(file, cx);
    cx.notify();
  }

  selectSection(section, cx) {
    this.selectFile(null, cx);
    this.selectedSection = section;
    this.lane = "files";
    this.handle.focus();
    cx.notify();
  }

  stageSelection(cx) {
    if (this.selectedSection) {
      const section = this.selectedSection;
      if (!["Changes", "Staged Changes"].includes(section) || !this.files.some(f => f.section === section)) return;
      this.action(section === "Staged Changes" ? "git-unstage" : "git-stage", null, cx);
      return;
    }
    const file = this.files.find(f => f.path === this.selectedFile && f.group === this.selectedGroup);
    if (file) this.action(file.group === "STAGED" ? "git-unstage" : "git-stage", file, cx);
  }

  loadDiff(file, cx, reset = true) {
    const request = ++this.diffRequest;
    const folder = this.folder;
    const key = this.mode === "changes" ? file.group : this.selected;
    this.diffLoading = true;
    this.diffError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = ["commit-diff", folder, key, file.path];
        if (file.oldPath) args.push(file.oldPath);
        const res = await this.cli(args);
        if (request !== this.diffRequest) return;
        if (res.error) { this.diffError = res.error; this.diffRows = []; }
        else {
          this.diffRows = diffRows(res.diff);
          this.diffWidth = this.diffRows.reduce((width, row) => Math.max(width, (row.text.length + 1) * 7 + 105), 300);
          this.diffCursor = Math.min(this.diffCursor, Math.max(0, this.diffRows.length - 1));
          if (reset) this.diffScroll.scroll_to_item(0);
        }
      } catch (e) {
        if (request === this.diffRequest) this.diffError = String(e?.message ?? e);
      } finally {
        if (request === this.diffRequest) { this.diffLoading = false; cx.notify(); }
      }
    });
  }

  focusLane(lane, cx, selectFirst = true) {
    this.lane = lane;
    this.handle.focus();
    if (selectFirst && lane === "files" && !this.selectedFile && !this.selectedSection && this.files.length) this.selectFile(this.files[0], cx);
    cx.notify();
  }

  move(target, cx) {
    if (this.lane === "commits") {
      const keys = ["WORKING", ...this.commits.map(c => c.hash)];
      const index = Math.max(0, Math.min(keys.length - 1, target));
      this.select(keys[index], cx);
      this.commitScroll.scroll_to_item(index);
    } else if (this.lane === "files") {
      const entries = this.mode === "changes" ? this.sourceEntries() : this.files;
      if (!entries.length) return;
      const index = Math.max(0, Math.min(entries.length - 1, target));
      const entry = entries[index];
      if (entry.header) this.selectSection(entry.header, cx);
      else if (this.selectedFile !== entry.path || this.selectedGroup !== (entry.group ?? null)) this.selectFile(entry, cx);
      if (this.mode === "changes") {
        if (!entry.header) this.sourceScrolls[entry.section].scroll_to_item(this.files.filter(f => f.section === entry.section).findIndex(f => f.path === entry.path && f.group === entry.group));
      } else this.fileScroll.scroll_to_item(index);
    } else {
      this.diffCursor = Math.max(0, Math.min(this.diffRows.length - 1, target));
      this.diffScroll.scroll_to_item(this.diffCursor, "center");
    }
    cx.notify();
  }

  keyDown(e, cx, consume = true) {
    const chord = e.keystroke || e.key;
    if (this.editing) {
      if (e.key === "escape") {
        this.editing = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
        return;
      }
      if (e.modifiers?.platform && ["enter", "return"].includes(e.key)) { this.commit(cx); cx.stop_propagation(); }
      return;
    }
    if (this.mode === "changes" && e.key === "r") { this.load(cx); cx.stop_propagation(); return; }
    const key = e.key === "g" && (e.modifiers?.shift || e.key_char === "G") ? "G" : e.key;
    if (e.modifiers?.platform || e.modifiers?.alt) return;
    if (e.modifiers?.control && !["ctrl-d", "ctrl-u"].includes(chord)) return;
    if (this.mode === "changes" && key === "i") {
      this.count = "";
      this.lastG = 0;
      this.message.focus();
      this.editing = true;
      if (consume) cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.mode === "changes" && key === "s") {
      this.stageSelection(cx);
      this.count = "";
      this.lastG = 0;
      if (consume) cx.stop_propagation();
      return;
    }
    if (this.mode === "changes" && this.lane === "files" && this.selectedSection && ["l", "right", "enter", "return", "h", "left"].includes(key)) {
      const section = this.selectedSection;
      this.collapsed[section] = ["h", "left"].includes(key) ? true : ["enter", "return"].includes(key) ? !this.collapsed[section] : false;
      if (consume) cx.stop_propagation();
      cx.notify();
      return;
    }
    const entries = this.mode === "changes" ? this.sourceEntries() : this.files;
    const keys = this.lane === "commits" ? ["WORKING", ...this.commits.map(c => c.hash)] : this.files.map(f => f.path);
    const index = this.lane === "diff" ? this.diffCursor : this.lane === "files" && this.mode === "changes" ? entries.findIndex(f => this.selectedSection ? f.header === this.selectedSection : !f.header && f.path === this.selectedFile && f.group === this.selectedGroup) : keys.indexOf(this.lane === "commits" ? this.selected : this.selectedFile);
    const size = this.lane === "diff" ? this.diffRows.length : this.lane === "files" ? entries.length : keys.length;
    if (/^[1-9]$/.test(key) || (key === "0" && this.count)) {
      this.count = (this.count + key).slice(0, 4);
    } else if (key === "g") {
      if (Date.now() - this.lastG < 800) { this.move(0, cx); this.lastG = 0; this.count = ""; }
      else this.lastG = Date.now();
    } else {
      const count = Number(this.count) || 1;
      const hadCount = Boolean(this.count);
      this.count = "";
      this.lastG = 0;
      if (["j", "down"].includes(key)) this.move(index + count, cx);
      else if (["k", "up"].includes(key)) this.move(index - count, cx);
      else if (key === "G" || key === "end") this.move(hadCount ? count - 1 : size - 1, cx);
      else if (key === "home") this.move(0, cx);
      else if (chord === "ctrl-d" || chord === "ctrl-u") this.move(index + (chord === "ctrl-d" ? 1 : -1) * count * (this.lane === "diff" ? Math.max(1, Math.floor(this.diffHeight / 40)) : 5), cx);
      else if (["l", "right", "enter", "return"].includes(key)) this.focusLane(this.lane === "commits" ? "files" : "diff", cx);
      else if (["h", "left"].includes(key)) this.focusLane(this.lane === "diff" || this.mode === "changes" ? "files" : "commits", cx);
      else if (key === "tab" || chord === "shift-tab") {
        const lanes = this.mode === "changes" ? ["files", "diff"] : ["commits", "files", "diff"];
        const step = e.modifiers?.shift || chord === "shift-tab" ? -1 : 1;
        this.focusLane(lanes[(lanes.indexOf(this.lane) + step + lanes.length) % lanes.length], cx);
      } else if (key === "escape") {
        if (this.lane !== (this.mode === "changes" ? "files" : "commits")) this.focusLane(this.lane === "diff" || this.mode === "changes" ? "files" : "commits", cx);
        else if (this.panel) run("pane.go", { direction: "left" });
        else this.dismiss();
      } else if (key === "q") this.dismiss();
      else return;
    }
    if (consume) cx.stop_propagation();
    cx.notify();
  }

  sectionTitle(label, lane, t, detail = "") {
    return h_flex().h(28).flex_none().px(10).gap(8).items_center()
      .border_b(1).border_color(this.lane === lane ? t.accent : t.border)
      .text_color(this.lane === lane ? t.foreground : t.muted).text_size(11)
      .child(div().font_semibold().child(label))
      .child(div().flex_1().truncate().text_color(t.dim).child(detail));
  }

  commitRow(key, title, subtitle, t) {
    return v_flex().id(`commit-${key}`).flex_none().px(10).py(6).gap(2).rounded(5).cursor_pointer()
      .when(this.selected === key, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.focusLane("commits", cx); this.select(key, cx); })
      .child(div().text_size(12).truncate().child(title))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(subtitle));
  }

  commitList(t) {
    return v_flex().size_full().min_w(0).min_h(0).overflow_hidden()
      .child(this.sectionTitle("Commits", "commits", t, `${this.commits.length}`))
      .child(v_flex().id("commits-list").flex_1().min_h(0).w_full().p(5).gap(2)
        .overflow_y_scroll().track_scroll(this.commitScroll)
        .child(this.commitRow("WORKING", "Working tree", "Uncommitted changes", t))
        .children(this.commits.map(c => this.commitRow(c.hash, c.subject || "(no message)", `${c.short} · ${c.author} · ${c.date}`, t))));
  }

  fileList(t) {
    return v_flex().size_full().min_w(0).min_h(0).overflow_hidden()
      .child(this.sectionTitle("Changed files", "files", t, this.filesLoading ? "Loading…" : `${this.files.length}`))
      .child(v_flex().id("commit-files").flex_1().min_h(0).w_full().p(5).gap(2)
        .overflow_y_scroll().track_scroll(this.fileScroll)
        .when(Boolean(this.filesError), el => el.child(div().p(8).text_color(t.blocked).child(this.filesError)))
        .when(!this.filesLoading && !this.files.length && !this.filesError, el => el.child(div().p(8).text_color(t.dim).child("No changed files")))
        .children(this.files.map((file, i) => h_flex().id(`changed-file-${i}`).h(28).flex_none().px(6).gap(7).items_center().rounded(5).cursor_pointer()
          .when(this.selectedFile === file.path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.focusLane("files", cx, false); if (this.selectedFile !== file.path) this.selectFile(file, cx); })
          .child(div().w(14).flex_none().text_color(file.status === "A" ? t.ansi2 : file.status === "D" ? t.ansi1 : t.accent).child(file.status))
          .child(div().flex_1().min_w(0).truncate().child(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)))));
  }

  diffRow({ kind, oldNumber, newNumber, text }, t, index) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10)
      .when(kind === "+", e => e.bg(t.ansi2 + "18"))
      .when(kind === "-", e => e.bg(t.ansi1 + "18"))
      .when(this.lane === "diff" && index === this.diffCursor, e => e.bg(t.selected))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(oldNumber === undefined ? "" : String(oldNumber)))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(newNumber === undefined ? "" : String(newNumber)))
      .child(div().w(8).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  leaveEditor() {
    this.editRequest++;
    this.editLoading = false;
  }

  openEditor(cx) {
    if (this.mode !== "changes" || !this.selectedFile || this.editLoading) return;
    const folder = this.folder;
    const file = this.selectedFile;
    const tab = focused()?.tab;
    const pane = focused()?.pane || panes().find(p => p.tab === tab)?.pane;
    const request = ++this.editRequest;
    this.editLoading = true;
    this.editorError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const version = await exec("nvim", ["--version"]);
        if (request !== this.editRequest) return;
        if (version.code !== 0) throw new Error("Install Neovim and make nvim available on PATH");
        const res = await this.cli(["git-file", folder, file]);
        if (request !== this.editRequest || focused()?.tab !== tab) return;
        if (res.error) throw new Error(res.error);
        if (props()?.overlay) closeOverlay(props().overlay);
        if (pane) run("pane.focus", { pane });
        // Pass the path as an argv entry: filenames never become shell commands.
        run("terminal.open", { argv: ["nvim", "--", res.path], folder, place: pane ? "right" : "tab", name: "Neovim" });
      } catch (e) {
        if (request === this.editRequest) this.editorError = `Could not open Neovim: ${e?.message ?? e}`;
      } finally {
        if (request === this.editRequest) { this.editLoading = false; cx.notify(); }
      }
    });
  }

  diffPane(t) {
    const message = this.diffLoading && !this.diffRows.length ? "Loading diff…" : this.diffError || (!this.selectedFile ? this.selectedSection ? `${this.selectedSection} selected${this.selectedSection === "Changes" ? " · s to stage all" : this.selectedSection === "Staged Changes" ? " · s to unstage all" : ""}` : "Select a changed file to view its diff" : !this.diffRows.length ? "No text changes" : "");
    return v_flex().flex_1().min_w(0).min_h(0)
      .when(this.panel, el => el.w_full()).when(!this.panel, el => el.h_full())
      .child(this.sectionTitle("Diff", "diff", t, this.selectedFile ? `${this.selectedFile}${this.mode === "changes" ? this.selectedGroup === "STAGED" ? " · Staged" : " · Working Tree" : ""}` : ""))
      .when(this.mode === "changes", el => el.child(h_flex().h(30).flex_none().px(6).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tool("open-in-neovim", this.editLoading ? "Opening…" : "Open in Neovim", cx => this.openEditor(cx), t, Boolean(this.selectedFile) && !this.editLoading))))
      .when(Boolean(this.editorError), el => el.child(div().px(10).py(6).text_color(t.blocked).text_size(11).child(this.editorError)))
      .child(div().id("diff-pane").flex_1().min_h(0).w_full().relative().font_family("JetBrains Mono").text_size(11)
        .on_mouse_down("left", (_e, cx) => this.focusLane("diff", cx))
        .on_size_change(size => { this.diffHeight = size.height; })
        .when(Boolean(message), el => el.child(div().p(12).text_color(this.diffError ? t.blocked : t.dim).child(message)))
        .when(!message, el => el
          .child(div().id("commit-diff-x").absolute().inset_0().overflow_x_scrollbar()
            .child(div().w_full().min_w(this.diffWidth).h_full()
              .child(v_virtual_list("commit-diff", this.diffRows.length, 20, i => String(i),
                range => this.diffRows.slice(range.start, range.end).map((row, i) => this.diffRow(row, t, range.start + i)))
                .track_scroll(this.diffScroll).size_full())))
          .child(Scrollbar.vertical("commit-diff").viewport_from_layout().absolute().inset_0())));
  }

  switchMode(mode, cx) {
    if (this.mode === mode || this.busy) return;
    this.leaveEditor();
    this.editorError = "";
    this.mode = mode;
    this.generation++;
    this.filesRequest++;
    this.diffRequest++;
    this.statusRequest++;
    this.selected = null;
    this.selectedFile = null;
    this.selectedSection = null;
    this.files = [];
    this.diffRows = [];
    this.lane = mode === "changes" ? "files" : "commits";
    this.load(cx);
    cx.notify();
  }

  loadStatus(cx) {
    const request = ++this.statusRequest;
    const folder = this.folder;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const res = await this.cli(["git-status", folder]);
        if (request !== this.statusRequest) return;
        if (res.error) throw new Error(res.error);
        this.error = "";
        this.status = res;
        this.files = [
          ...(res.conflicts || []).map(f => ({ ...f, group: "UNSTAGED", section: "Merge Changes" })),
          ...(res.staged || []).map(f => ({ ...f, group: "STAGED", section: "Staged Changes" })),
          ...(res.changes || []).map(f => ({ ...f, group: "UNSTAGED", section: "Changes" })),
          ...(res.untracked || []).map(f => ({ ...f, group: "UNTRACKED", section: "Changes", status: "U" })),
        ];
        const selected = this.files.find(f => f.path === this.selectedFile && f.group === this.selectedGroup);
        if (!this.selectedSection || !this.sourceEntries().some(entry => entry.header === this.selectedSection)) {
          if (selected) this.loadDiff(selected, cx, false);
          else this.selectFile(null, cx);
        }
      } catch (e) {
        if (request === this.statusRequest) this.error = String(e?.message ?? e);
      } finally {
        if (request === this.statusRequest) { this.loading = false; cx.notify(); }
      }
    });
  }

  action(command, file, cx, message) {
    if (this.busy || this.loading || this.error) return;
    const generation = this.generation;
    const folder = this.folder;
    this.busy = true;
    this.actionError = "";
    const args = [command, folder];
    if (message !== undefined) args.push(message);
    else if (file) { args.push(file.path); if (file.oldPath) args.push(file.oldPath); }
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await this.cli(args);
        if (res.error) throw new Error(res.error);
        if (message !== undefined && this.drafts[folder] === message) {
          this.drafts[folder] = "";
          if (folder === this.folder) this.message.set_value("");
        }
      } catch (e) {
        if (generation === this.generation) this.actionError = String(e?.message ?? e);
      } finally {
        this.busy = false;
        if (generation === this.generation) this.load(cx);
        cx.notify();
      }
    });
  }

  commit(cx) {
    if (!this.message.value().trim() || !this.status.staged?.length || this.status.conflicts?.length) return;
    this.action("git-commit", null, cx, this.message.value());
  }

  tool(id, label, action, t, enabled = true) {
    return div().id(id).h(24).px(7).flex().items_center().justify_center().rounded(3)
      .text_color(enabled ? t.foreground : t.dim).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); }).child(label);
  }

  sourceEntries() {
    return ["Merge Changes", "Staged Changes", "Changes"].flatMap(section => {
      const files = this.files.filter(f => f.section === section);
      return files.length || section !== "Merge Changes" ? [{ header: section, count: files.length }, ...(this.collapsed[section] ? [] : files)] : [];
    });
  }

  sourceRow(file, t, enabled) {
    const staged = file.group === "STAGED";
    const parts = file.path.split("/");
    const name = parts.pop();
    const color = file.status === "D" ? t.ansi1 : ["A", "U", "??"].includes(file.status) ? t.ansi2 : t.accent;
    return h_flex().id(`source-${file.group}-${file.path}`).h(26).flex_none().px(10).gap(6).items_center().cursor_pointer()
      .when(this.selectedFile === file.path && this.selectedGroup === file.group, e => e.bg(t.selected))
      .hover(e => e.bg(t.hover))
      .on_click((_e, cx) => { this.focusLane("files", cx, false); this.selectFile(file, cx); })
      .child(div().text_color(color).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(file.oldPath ? `${file.oldPath} → ${parts.join("/")}` : parts.join("/")))
      .child(this.tool(`stage-${file.group}-${file.path}`, staged ? "−" : "+", cx => this.action(staged ? "git-unstage" : "git-stage", file, cx), t, enabled))
      .child(div().w(15).text_size(11).text_color(color).child(file.status));
  }

  savedSize(id, index, fallback) {
    const sizes = shared(`orca.git.sizes.${id}`);
    const value = Array.isArray(sizes) ? sizes[index] : null;
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  rememberSizes(id, sizes) {
    if (!Array.isArray(sizes) || !sizes.length || !sizes.every(size => Number.isFinite(size) && size > 0)) return;
    setShared(`orca.git.sizes.${id}`, sizes);
  }

  sourceControl(t) {
    const enabled = !this.busy && !this.loading && !this.error;
    const canCommit = enabled && Boolean(this.message.value().trim()) && Boolean(this.status.staged?.length) && !this.status.conflicts?.length;
    const entries = this.sourceEntries();
    const id = `git-source-${this.panel ? "panel" : "dialog"}`;
    return v_resizable(id).size_full().on_resize(sizes => this.rememberSizes(id, sizes))
      .child(resizable_panel().size(this.savedSize(id, 0, 130)).size_range(100).child(
        v_flex().id("commit-form").size_full().min_h(0).overflow_y_scroll().p(10).gap(8)
        .child(h_flex().gap(6).items_center()
          .child(svg("mods/orca-commits/branch.svg").size(14).text_color(t.dim))
          .child(div().flex_1().truncate().child(this.status.branch || "Repository"))
          .when(Boolean(this.status.upstream), el => el.child(div().text_size(10).text_color(t.dim).child(`${this.status.behind || 0}↓ ${this.status.ahead || 0}↑`))))
        .child(Input.new(this.message).h(36).px(8).rounded(3).border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
        .child(div().id("git-commit").h(30).flex().items_center().justify_center().rounded(3)
          .bg(canCommit ? t.accent : t.raised).text_color(canCommit ? t.accent_foreground : t.dim).cursor_pointer()
          .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Working…" : "✓  Commit"))
        .when(Boolean(this.actionError), el => el.child(div().text_size(11).text_color(t.blocked).child(this.actionError)))))
      .child(resizable_panel().size(this.savedSize(id, 1, 180)).size_range(60).child(v_flex().id("source-files").size_full().min_h(0).overflow_hidden()
        .children(entries.filter(entry => entry.header).map(entry => {
          const section = entry.header;
          const staged = section === "Staged Changes";
          return v_flex().id(`source-group-${section}`).min_h(28).min_w(0).overflow_hidden()
            .when(Boolean(this.collapsed[section]) || entry.count === 0, el => el.flex_none().h(28))
            .when(!this.collapsed[section] && entry.count > 0, el => el.flex_1())
            .child(h_flex().id(`group-${section}`).h(28).flex_none().px(6).gap(4).items_center().bg(this.selectedSection === section ? t.selected : t.raised).cursor_pointer()
              .on_click((_e, cx) => this.selectSection(section, cx))
              .child(div().id(`collapse-${section}`).w(12).text_color(t.dim).cursor_pointer()
                .on_click((_e, cx) => { cx.stop_propagation(); this.selectSection(section, cx); this.collapsed[section] = !this.collapsed[section]; cx.notify(); })
                .child(this.collapsed[section] ? "›" : "⌄"))
              .child(div().flex_1().font_semibold().text_size(11).child(section))
              .child(div().rounded(8).px(5).bg(t.hover).text_size(10).child(String(entry.count)))
              .when(section !== "Merge Changes", el => el.child(this.tool(`all-${section}`, staged ? "−" : "+", cx => this.action(staged ? "git-unstage" : "git-stage", null, cx), t, enabled && entry.count > 0))))
            .when(!this.collapsed[section] && entry.count > 0, el => el.child(v_flex().id(`source-list-${section}`).flex_1().min_h(0).overflow_y_scroll().track_scroll(this.sourceScrolls[section])
              .children(this.files.filter(file => file.section === section).map(file => this.sourceRow(file, t, enabled)))));
        }))));
  }

  sections(t) {
    const id = `git-sections-${this.panel ? "panel" : "dialog"}-${this.mode}`;
    const group = (this.panel ? v_resizable(id) : h_resizable(id))
      .w_full().h(Math.max(0, this.height - 88)).min_h(0)
      .on_resize(sizes => this.rememberSizes(id, sizes));
    if (this.mode === "changes") {
      return group
        .child(resizable_panel().size(this.savedSize(id, 0, this.panel ? Math.min(340, Math.max(220, (this.height - 88) * 0.55)) : 310))
          .size_range(this.panel ? 180 : 220).child(this.sourceControl(t)))
        .child(resizable_panel().size(this.savedSize(id, 1, this.panel ? Math.max(100, this.height - 428) : 650)).size_range(100).child(this.diffPane(t)));
    }
    return group
      .child(resizable_panel().size(this.savedSize(id, 0, this.panel ? 185 : 235)).size_range(80).child(this.commitList(t)))
      .child(resizable_panel().size(this.savedSize(id, 1, this.panel ? 160 : 215)).size_range(80).child(this.fileList(t)))
      .child(resizable_panel().size(this.savedSize(id, 2, this.panel ? Math.max(100, this.height - 433) : 600)).size_range(100).child(this.diffPane(t)));
  }

  render(cx) {
    if (!checking()) this.syncFolder(cx);
    const t = theme();
    return v_flex().id("orca-commits").track_focus(this.handle).on_key_down((e, cx) => this.keyDown(e, cx))
      .on_size_change((size, cx) => { if (this.height !== size.height) { this.height = size.height; cx.notify(); } })
      .size_full().min_h(0).overflow_hidden().bg(this.panel ? t.background : t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().text_size(11).text_color(t.muted).child("SOURCE CONTROL"))
        .child(this.tool("refresh-git", "↻", cx => this.load(cx), t, !this.loading && !this.busy))
        .child(this.tool("close-commits", "×", () => this.dismiss(), t)))
      .child(h_flex().h(30).flex_none().px(6).gap(6).items_center().border_b(1).border_color(t.border)
        .children([["changes", "Changes"], ["history", "History"]].map(([mode, label]) =>
          div().id(`git-mode-${mode}`).h(28).px(8).flex().items_center().cursor_pointer()
            .text_color(this.mode === mode ? t.foreground : t.dim)
            .border_b(this.mode === mode ? 2 : 0).border_color(t.accent)
            .on_click((_e, cx) => this.switchMode(mode, cx)).child(label))))
      .child(this.error ? div().p(12).text_color(t.blocked).child(this.error)
        : this.sections(t))
      .child(div().h(24).flex_none().px(10).flex().items_center().text_size(10).text_color(t.dim).border_t(1).border_color(t.border)
        .child(this.mode === "changes" ? this.editing ? "Esc back to navigation · ⌘Enter commit" : "i message · j/k move · h/l panes · s stage/unstage · r refresh · ⌘Enter commit" : "j/k move · h/l panes · gg/G ends · Ctrl-d/u page"));
  }
}
