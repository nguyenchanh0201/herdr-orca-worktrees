import { View, div } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { spaces, exec, run, closeOverlay, props, theme, checking } from "herdr";
import config from "./config.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default class OrcaRemove extends View {
  init(_p, cx) {
    if (checking()) return;
    this.state = "loading";
    this.spaceId = props()?.space ?? null;
    this.spaceName = "";
    this.worktree = null;
    this.preflight = null;
    this.force = false;
    this.archiveOutput = "";
    this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => this.load(cx));
  }

  async cli(args, timeout) {
    const r = await exec(config.node, [config.cli, ...args], timeout ? { timeout } : undefined);
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
    }
    return JSON.parse((r.stdout || "").trim());
  }

  close() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  async load(cx) {
    try {
      const space = spaces().find((s) => s.id === this.spaceId);
      if (!space) {
        this.state = "error";
        this.error = "Space is gone.";
        cx.notify();
        return;
      }
      this.spaceName = space.name || space.folder;
      if (space.machine !== null || !space.folder) {
        this.state = "not-worktree";
        cx.notify();
        return;
      }

      const info = await this.cli(["info", space.folder]);
      if (info.error || !info.linked) {
        this.state = "not-worktree";
        cx.notify();
        return;
      }

      this.worktree = info.worktree ?? space.folder;
      const pf = await this.cli(["preflight", this.worktree]);
      if (pf.error) {
        this.state = "error";
        this.error = pf.error;
        cx.notify();
        return;
      }

      this.preflight = pf;
      this.force = (pf.dirty?.length ?? 0) > 0;
      this.state = "confirm";
    } catch (err) {
      this.state = "error";
      this.error = err?.message ? err.message : String(err);
    }
    cx.notify();
  }

  confirmRemove(cx) {
    if (this.state !== "confirm") return;
    cx.spawn(async (cx) => {
      if (this.preflight?.archive) {
        this.state = "archiving";
        cx.notify();
        try {
          const arch = await this.cli(["archive", this.worktree], 600_000);
          if (arch.error) {
            this.archiveOutput = arch.error;
            this.state = "archive-failed";
            cx.notify();
            return;
          }
          if (arch.code !== 0) {
            this.archiveOutput = arch.output || `Archive script exited with code ${arch.code}.`;
            this.state = "archive-failed";
            cx.notify();
            return;
          }
        } catch (err) {
          this.archiveOutput = err?.message ? err.message : String(err);
          this.state = "archive-failed";
          cx.notify();
          return;
        }
      }
      await this.doRemove(cx);
    });
  }

  removeAnyway(cx) {
    if (this.state !== "archive-failed") return;
    cx.spawn(async (cx) => this.doRemove(cx));
  }

  async doRemove(cx) {
    this.state = "removing";
    cx.notify();
    try {
      const args = ["remove", this.worktree, ...(this.force ? ["--force"] : [])];
      const res = await this.cli(args, 600_000);
      if (res.ok) {
        run("space.close", { id: this.spaceId, confirmed: true });
        this.close();
        return;
      }
      this.state = "error";
      this.error = res.error || "Failed to remove worktree.";
    } catch (err) {
      this.state = "error";
      this.error = err?.message ? err.message : String(err);
    }
    cx.notify();
  }

  onKey(e, cx) {
    if (e.key === "escape" && this.state !== "archiving" && this.state !== "removing") {
      this.close();
      cx.stop_propagation();
    }
  }

  button(id, label, bg, fg, onClick, borderColor) {
    return Button.new(id)
      .h(32)
      .px(14)
      .flex()
      .items_center()
      .justify_center()
      .rounded(7)
      .border(1)
      .border_color(borderColor ?? bg)
      .bg(bg)
      .text_size(12.5)
      .text_color(fg)
      .cursor_pointer()
      .hover((s) => s.opacity(0.88))
      .on_click(onClick)
      .child(label);
  }

  renderBody(t, state, cx) {
    if (state === "loading" || state === "archiving" || state === "removing") {
      const label =
        state === "loading"
          ? "Checking worktree…"
          : state === "archiving"
            ? "Running archive script…"
            : "Removing worktree…";
      return v_flex()
        .gap(14)
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .text_color(t.muted)
            .child(div().frames(SPINNER, 90))
            .child(label),
        );
    }

    if (state === "not-worktree") {
      return v_flex()
        .gap(14)
        .child(div().text_color(t.muted).child("This space is not a linked worktree."))
        .child(
          h_flex()
            .justify_end()
            .child(this.button("orca-rm-close", "Close", t.raised, t.foreground, () => this.close(), t.input)),
        );
    }

    if (state === "error") {
      return v_flex()
        .gap(14)
        .child(div().text_color(t.blocked).child(this.error || "Unknown error."))
        .child(
          h_flex()
            .justify_end()
            .child(this.button("orca-rm-close", "Close", t.raised, t.foreground, () => this.close(), t.input)),
        );
    }

    if (state === "archive-failed") {
      return v_flex()
        .gap(12)
        .child(div().text_color(t.blocked).child("Archive script failed:"))
        .child(
          div()
            .id("orca-rm-archive-out")
            .max_h(180)
            .overflow_y_scrollbar()
            .p(10)
            .rounded(6)
            .border(1)
            .border_color(t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(t.muted)
            .child(this.archiveOutput || "(no output)"),
        )
        .child(
          h_flex()
            .justify_end()
            .gap(8)
            .child(this.button("orca-rm-cancel", "Cancel", t.raised, t.foreground, () => this.close(), t.input))
            .child(
              this.button(
                "orca-rm-anyway",
                "Remove anyway",
                this.force ? t.blocked : t.solid,
                this.force ? "#ffffff" : t.solid_foreground,
                (_e, cx) => this.removeAnyway(cx),
              ),
            ),
        );
    }

    const dirty = this.preflight?.dirty ?? [];
    const branch = this.preflight?.branch || "(detached)";
    return v_flex()
      .gap(12)
      .child(
        v_flex()
          .gap(4)
          .p(10)
          .rounded(6)
          .border(1)
          .border_color(t.border)
          .bg(t.background)
          .text_size(12)
          .child(
            h_flex()
              .gap(8)
              .child(div().flex_none().text_color(t.dim).child("Branch"))
              .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(branch)),
          )
          .child(
            h_flex()
              .gap(8)
              .child(div().flex_none().text_color(t.dim).child("Path"))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.worktree ?? "")),
          ),
      )
      .when(dirty.length > 0, (el) =>
        el
          .child(div().text_color(t.blocked).child("Uncommitted changes will be lost:"))
          .child(
            div()
              .id("orca-rm-dirty")
              .max_h(160)
              .overflow_y_scrollbar()
              .p(10)
              .rounded(6)
              .border(1)
              .border_color(t.border)
              .bg(t.background)
              .text_size(11.5)
              .text_color(t.muted)
              .child(dirty.join("\n")),
          ),
      )
      .when(dirty.length === 0, (el) =>
        el.child(
          div()
            .text_color(t.muted)
            .child(
              this.preflight?.archive
                ? "Runs scripts.archive, removes the checkout, and closes this space. The branch stays."
                : "Removes the checkout and closes this space. The branch stays.",
            ),
        ),
      )
      .child(
        h_flex()
          .justify_end()
          .gap(8)
          .child(this.button("orca-rm-cancel", "Cancel", t.raised, t.foreground, () => this.close(), t.input))
          .child(
            dirty.length > 0
              ? this.button("orca-rm-force", "Force remove", t.blocked, "#ffffff", (_e, cx) => this.confirmRemove(cx))
              : this.button(
                  "orca-rm-go",
                  "Remove",
                  t.solid,
                  t.solid_foreground,
                  (_e, cx) => this.confirmRemove(cx),
                ),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const state = this.state ?? "loading";
    const title = `Remove worktree${this.spaceName ? ` (${this.spaceName})` : ""}`;
    const canClose = state !== "archiving" && state !== "removing";

    const root = v_flex()
      .id("orca-remove")
      .w_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground);

    if (this.handle) {
      root.track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx));
    }

    return root
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
          .when(canClose, (el) =>
            el.child(
              div()
                .id("orca-rm-esc")
                .px(6)
                .py(2)
                .rounded(5)
                .text_size(11)
                .text_color(t.dim)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => this.close())
                .child("Esc"),
            ),
          ),
      )
      .child(this.renderBody(t, state, cx));
  }
}
