import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, machines, focused, exec, run, openOverlay, notify, theme, checking } from "herdr";
import config from "./config.js";

export default class OrcaSetup extends View {
  init(_p, cx) {
    if (checking()) return;
    this.seen = null;
    this.linked = {};
    this.probing = new Set();
    this.status = "";
    this.error = false;
    cx.timer.every(3000, (cx) => this.scan(cx));
    this.scan(cx);
  }

  async cli(args, timeout) {
    const r = await exec(config.node, [config.cli, ...args], timeout ? { timeout } : undefined);
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim());
    }
    return JSON.parse((r.stdout || "").trim());
  }

  probe(space, cx) {
    if (this.probing.has(space.id)) return;
    this.probing.add(space.id);
    const folder = space.folder;
    cx.spawn(async (cx) => {
      try {
        const info = await this.cli(["info", folder]);
        this.linked[space.id] = info.error
          ? { folder, linked: false, worktree: null }
          : { folder, linked: Boolean(info.linked), worktree: info.worktree ?? folder };
      } catch {
        this.linked[space.id] = { folder, linked: false, worktree: null };
      } finally {
        this.probing.delete(space.id);
      }
      cx.notify();
    });
  }

  scan(cx) {
    if (checking()) return;
    if (machines().find((m) => m.name === null)?.layout !== "ready") return;
    const local = spaces().filter((s) => s.machine === null && s.folder);
    if (this.seen === null) {
      this.seen = new Set(local.map((s) => s.id));
      for (const s of local) this.probe(s, cx);
      return;
    }
    for (const s of local) {
      if (this.seen.has(s.id)) continue;
      this.seen.add(s.id);
      cx.spawn(async (cx) => this.handle(s, cx));
    }
  }

  async handle(space, cx) {
    const base = space.folder.split("/").filter(Boolean).pop() || space.name || space.id;
    this.probing.add(space.id);
    this.error = false;
    this.status = `setting up ${base}…`;

    try {
      await cx.sleep(0);
      cx.notify();

      const info = await this.cli(["info", space.folder]);
      if (info.error) {
        this.linked[space.id] = { folder: space.folder, linked: false, worktree: null };
        this.status = "";
        cx.notify();
        return;
      }

      this.linked[space.id] = {
        folder: space.folder,
        linked: Boolean(info.linked),
        worktree: info.worktree ?? space.folder,
      };
      if (!info.linked) {
        this.status = "";
        cx.notify();
        return;
      }

      const res = await this.cli(["setup", info.worktree], 600_000);
      if (res.error) throw new Error(res.error);
      if (!res.fresh) {
        this.status = "";
        cx.notify();
        return;
      }

      if (res.runner) {
        run("tab.new", {
          space: space.id,
          name: "Setup",
          folder: info.worktree,
          argv: ["bash", res.runner],
          focus: false,
        });
      }

      const parts = [`${res.linked.length} linked`, `${res.copied.length} copied`];
      if (res.skipped.length > 0) parts.push(`${res.skipped.length} skipped`);
      const summary = parts.join(", ");

      const anything = res.linked.length > 0 || res.copied.length > 0 || Boolean(res.runner);
      if (anything) {
        this.status = `${base}: ${summary}`;
        notify({ title: "Orca setup", body: summary });
      } else if (res.skipped.length > 0) {
        this.status = `${base}: ${summary}`;
      } else {
        this.status = "";
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      this.error = true;
      this.status = msg;
      notify({ title: "Orca setup", body: msg, level: "error" });
    } finally {
      this.probing.delete(space.id);
    }
    cx.notify();
  }

  render(cx) {
    this.scan(cx);
    const t = theme();
    const f = focused();
    const focusId = f?.space ?? null;
    const focusSpace = focusId ? spaces().find((s) => s.id === focusId) : null;

    if (!checking() && focusSpace && focusSpace.machine === null && focusSpace.folder) {
      const cached = this.linked?.[focusId];
      if (!cached || cached.folder !== focusSpace.folder) {
        this.probe(focusSpace, cx);
      }
    }

    const showRemove = Boolean(
      focusSpace &&
      focusSpace.machine === null &&
      this.linked?.[focusId]?.linked,
    );

    return h_flex()
      .id("orca-setup-strip")
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .justify_end()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .when(Boolean(this.status), (el) =>
        el.child(
          div()
            .min_w(0)
            .truncate()
            .text_color(this.error ? t.blocked : t.muted)
            .child(this.status),
        ),
      )
      .when(showRemove, (el) =>
        el.child(
          h_flex()
            .id("orca-remove-btn")
            .flex_none()
            .h(20)
            .px(8)
            .items_center()
            .rounded(4)
            .border(1)
            .border_color(t.border)
            .bg(t.raised)
            .text_size(11)
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() =>
              openOverlay({
                mod: "orca-remove",
                kind: "dialog",
                width: 560,
                props: { space: focusId },
              }),
            )
            .child("Remove"),
        ),
      );
  }
}
