import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, shared, setShared, checking, closeOverlay, run, exec } from "herdr";
import { fmtMem, fmtCpu } from "./fmt.js";

const CARD_W = 360;
const SHELLS = new Set(["zsh", "bash", "fish", "sh"]);
const AGENT_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  agy: "Antigravity",
};

function isAgentName(agent) {
  return Boolean(agent) && !SHELLS.has(String(agent).toLowerCase());
}

function agentDisplayName(agent) {
  const key = String(agent || "").toLowerCase();
  return AGENT_NAMES[key] ?? agent;
}

function formatObservedTime(ms) {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

function compareItems(a, b, sort) {
  const mul = sort.dir === "asc" ? 1 : -1;
  if (sort.by === "name") {
    const na = String(a.name ?? a.label ?? "").toLowerCase();
    const nb = String(b.name ?? b.label ?? "").toLowerCase();
    return na.localeCompare(nb) * mul;
  }
  const va = sort.by === "cpu" ? (a.cpu ?? 0) : (a.rss ?? 0);
  const vb = sort.by === "cpu" ? (b.cpu ?? 0) : (b.rss ?? 0);
  return (va - vb) * mul;
}

export default class OrcaResourcesPanel extends View {
  init(_p, _cx) {
    let tab = "resources";
    try {
      const savedTab = localStorage.getItem("resources.tab");
      if (savedTab === "resources" || savedTab === "ptys") tab = savedTab;
    } catch {}
    this.tab = tab;

    let folded = new Set(["herdr"]);
    try {
      const raw = localStorage.getItem("resources.folded");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) folded = new Set(parsed);
      }
    } catch {}
    this.folded = folded;

    this.sort = { by: "mem", dir: "desc" };
    this.orderCache = new Map();
    this.detailsOpen = false;
    this.selected = new Set();
    this.confirming = null;
    this.ending = false;
    this.endErrors = [];
    this.unfoldedPtys = new Set();
    this.ptyDetails = new Map();

    if (checking() || !props()?.overlay) return;
    setShared("orca.resources.open", true);
  }

  destroy() {
    setShared("orca.resources.open", false);
  }

  close(overlay) {
    setShared("orca.resources.open", false);
    closeOverlay(overlay);
  }

  setTab(tab, cx) {
    this.tab = tab;
    try {
      localStorage.setItem("resources.tab", tab);
    } catch {}
    cx.notify();
  }

  toggleFold(key, cx) {
    if (this.folded.has(key)) this.folded.delete(key);
    else this.folded.add(key);
    try {
      localStorage.setItem("resources.folded", JSON.stringify(Array.from(this.folded)));
    } catch {}
    cx.notify();
  }

  toggleSort(by, cx) {
    if (this.sort.by === by) {
      this.sort = { by, dir: this.sort.dir === "desc" ? "asc" : "desc" };
    } else {
      this.sort = { by, dir: by === "name" ? "asc" : "desc" };
    }
    this.orderCache.clear();
    cx.notify();
  }

  sortStable(items, keyFn, scopeKey) {
    const list = [...(items ?? [])];
    const cached = this.orderCache.get(scopeKey);
    if (cached) {
      return list.sort((a, b) => {
        const ia = cached.get(keyFn(a)) ?? Infinity;
        const ib = cached.get(keyFn(b)) ?? Infinity;
        if (ia !== ib) return ia - ib;
        return compareItems(a, b, this.sort);
      });
    }
    list.sort((a, b) => compareItems(a, b, this.sort));
    if (list.length > 0) {
      const idxMap = new Map();
      for (let i = 0; i < list.length; i++) idxMap.set(keyFn(list[i]), i);
      this.orderCache.set(scopeKey, idxMap);
    }
    return list;
  }

  renderSparkline(t, points) {
    if (!Array.isArray(points) || points.length === 0) {
      return div().w(48).h(14).flex_none();
    }
    const slice = points.slice(-24);
    let min = Infinity;
    let max = -Infinity;
    for (const v of slice) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min;
    return h_flex()
      .w(48)
      .h(14)
      .flex_none()
      .items_end()
      .gap(1)
      .children(
        slice.map((v) => {
          const norm = span > 0 ? (v - min) / span : 0.5;
          const h = Math.max(2, Math.round(2 + norm * 12));
          return div().w(1).h(h).bg(t.muted);
        }),
      );
  }

  renderHeader(t, snap) {
    const count = snap?.count ?? 0;
    return v_flex()
      .w_full()
      .flex_none()
      .p(12)
      .gap(10)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .items_center()
              .gap(6)
              .child(svg("mods/orca-resources/chip.svg").size(14).flex_none().text_color(t.muted))
              .child(div().text_size(13).font_bold().text_color(t.foreground).child("Resource Manager")),
          )
          .child(
            div()
              .id("res-refresh")
              .px(8)
              .py(3)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.muted)
              .bg(t.raised)
              .border(1)
              .border_color(t.border)
              .hover((s) => s.text_color(t.foreground).bg(t.selected))
              .on_click((_e, cx) => {
                this.orderCache.clear();
                setShared("orca.resources.refresh", { at: Date.now() });
                cx.notify();
              })
              .child("Refresh"),
          ),
      )
      .child(
        h_flex()
          .w_full()
          .p(2)
          .gap(2)
          .rounded(6)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .children([
            div()
              .id("tab-resources")
              .flex_1()
              .py(4)
              .rounded(4)
              .cursor_pointer()
              .flex()
              .items_center()
              .justify_center()
              .text_size(12)
              .when(this.tab === "resources", (el) => el.bg(t.selected))
              .text_color(this.tab === "resources" ? t.foreground : t.muted)
              .on_click((_e, cx) => this.setTab("resources", cx))
              .child("Resources"),
            div()
              .id("tab-ptys")
              .flex_1()
              .py(4)
              .rounded(4)
              .cursor_pointer()
              .flex()
              .items_center()
              .justify_center()
              .gap(6)
              .text_size(12)
              .when(this.tab === "ptys", (el) => el.bg(t.selected))
              .text_color(this.tab === "ptys" ? t.foreground : t.muted)
              .on_click((_e, cx) => this.setTab("ptys", cx))
              .child("PTYs")
              .child(
                div()
                  .px(5)
                  .py(1)
                  .rounded(8)
                  .bg(t.border)
                  .text_size(10)
                  .text_color(t.muted)
                  .child(String(count)),
              ),
          ]),
      );
  }

  renderSortHeader(t) {
    const cols = [
      { id: "name", label: "Name", flex: true },
      { id: "cpu", label: "CPU", width: 54 },
      { id: "mem", label: "Mem", width: 72 },
    ];
    return h_flex()
      .w_full()
      .px(12)
      .py(6)
      .border_b(1)
      .border_color(t.border)
      .text_size(11)
      .text_color(t.dim)
      .children(
        cols.map((col) => {
          const active = this.sort.by === col.id;
          const arrow = active ? (this.sort.dir === "desc" ? " ↓" : " ↑") : "";
          const el = div()
            .id(`sort-${col.id}`)
            .cursor_pointer()
            .text_color(active ? t.foreground : t.dim)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.toggleSort(col.id, cx))
            .child(col.label)
            .when(Boolean(arrow), (d) => d.child(arrow));
          return col.flex ? el.flex_1() : el.w(col.width).flex_none().flex().justify_end();
        }),
      );
  }

  renderConfirmAndErrors(t, snap) {
    return v_flex()
      .w_full()
      .when(Boolean(this.confirming?.length), (el) =>
        el.child(
          v_flex()
            .w_full()
            .px(12)
            .py(8)
            .gap(6)
            .bg(t.raised)
            .border_b(1)
            .border_color(t.border)
            .child(
              div()
                .text_size(11)
                .text_color(t.foreground)
                .child(this.confirmMessage(this.confirming, snap)),
            )
            .child(
              h_flex()
                .gap(8)
                .justify_end()
                .child(
                  div()
                    .id("pty-confirm-cancel")
                    .px(8)
                    .py(3)
                    .rounded(4)
                    .cursor_pointer()
                    .border(1)
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.muted)
                    .on_click((_e, cx) => {
                      this.confirming = null;
                      cx.notify();
                    })
                    .child("Cancel"),
                )
                .child(
                  div()
                    .id("pty-confirm-end")
                    .px(8)
                    .py(3)
                    .rounded(4)
                    .cursor_pointer()
                    .bg(t.blocked)
                    .text_size(11)
                    .text_color(t.foreground)
                    .on_click((_e, cx) => this.endTerminals(this.confirming, snap, cx))
                    .child("End"),
                ),
            ),
        ),
      )
      .when(this.endErrors.length > 0, (el) =>
        el.child(
          v_flex()
            .w_full()
            .px(12)
            .py(6)
            .gap(2)
            .border_b(1)
            .border_color(t.border)
            .children(
              this.endErrors.map((err) =>
                div().text_size(11).text_color(t.blocked).child(err),
              ),
            ),
        ),
      );
  }

  renderResourcesTab(t, snap) {
    const cpu = snap?.cpu ?? 0;
    const rss = snap?.rss ?? 0;
    const projects = this.sortStable(snap?.projects, (p) => p.key, "projects");
    const other = this.sortStable(snap?.other, (r) => r.address, "other");
    const herdr = snap?.herdr ?? { cpu: 0, rss: 0 };

    return v_flex()
      .w_full()
      .flex_1()
      .overflow_hidden()
      .child(this.renderConfirmAndErrors(t, snap))
      .child(
        v_flex()
          .w_full()
          .px(12)
          .py(10)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .w_full()
              .items_baseline()
              .gap(10)
              .child(div().text_size(15).font_bold().text_color(t.foreground).child(fmtCpu(cpu)))
              .child(div().text_size(15).font_bold().text_color(t.foreground).child(fmtMem(rss)))
              .child(div().text_size(11).text_color(t.dim).child("Σ RSS")),
          )
          .child(
            div()
              .id("metric-details-toggle")
              .cursor_pointer()
              .text_size(11)
              .text_color(t.muted)
              .hover((s) => s.text_color(t.foreground))
              .on_click((_e, cx) => {
                this.detailsOpen = !this.detailsOpen;
                cx.notify();
              })
              .child(this.detailsOpen ? "▾ " : "▸ ")
              .child("Metric details"),
          )
          .when(this.detailsOpen, (el) =>
            el.child(
              v_flex()
                .gap(3)
                .pl(10)
                .text_size(11)
                .text_color(t.dim)
                .child("CPU is the sum of each process's %cpu from ps.")
                .child("Memory is the resident memory (RSS) of each terminal's process and all its children."),
            ),
          ),
      )
      .child(this.renderSortHeader(t))
      .child(
        v_flex()
          .w_full()
          .flex_1()
          .overflow_y_scroll()
          .children(
            projects.map((proj) => {
              const projFolded = this.folded.has(`p:${proj.key}`);
              return v_flex()
                .w_full()
                .child(
                  h_flex()
                    .id(`proj-${proj.key}`)
                    .w_full()
                    .px(12)
                    .py(6)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.toggleFold(`p:${proj.key}`, cx))
                    .child(
                      h_flex()
                        .flex_1()
                        .items_center()
                        .gap(6)
                        .overflow_hidden()
                        .child(div().text_size(10).text_color(t.dim).child(projFolded ? "▸" : "▾"))
                        .child(div().text_size(11).font_bold().text_color(t.muted).child(proj.name.toUpperCase())),
                    )
                    .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(proj.cpu)))
                    .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(proj.rss))),
                )
                .when(!projFolded, (el) =>
                  el.children(
                    this.sortStable(proj.worktrees, (w) => w.key, `p:${proj.key}`).map((wt) => {
                      const wtFolded = this.folded.has(`w:${wt.key}`);
                      return v_flex()
                        .w_full()
                        .child(
                          h_flex()
                            .id(`wt-${wt.key}`)
                            .w_full()
                            .pl(20)
                            .pr(12)
                            .py(5)
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.toggleFold(`w:${wt.key}`, cx))
                            .child(
                              h_flex()
                                .flex_1()
                                .items_center()
                                .gap(6)
                                .overflow_hidden()
                                .child(div().text_size(10).text_color(t.dim).child(wtFolded ? "▸" : "▾"))
                                .child(div().text_size(12).text_color(t.foreground).child(wt.name))
                                .child(this.renderSparkline(t, snap?.history?.[wt.key])),
                            )
                            .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(wt.cpu)))
                            .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(wt.rss))),
                        )
                        .when(!wtFolded, (el2) =>
                          el2.children(
                            this.sortStable(wt.terminals, (r) => r.address, `w:${wt.key}`).map((row) =>
                              h_flex()
                                .id(`res-term-${row.address}`)
                                .w_full()
                                .pl(34)
                                .pr(12)
                                .py(4)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover))
                                .on_click(() => run("pane.focus", { terminal: row.address }))
                                .child(
                                  h_flex()
                                    .flex_1()
                                    .items_center()
                                    .gap(6)
                                    .overflow_hidden()
                                    .child(div().w(6).h(6).rounded(3).flex_none().bg(t.working))
                                    .child(div().text_size(12).text_color(t.foreground).child(row.label)),
                                )
                                .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(row.cpu)))
                                .child(div().w(66).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(row.rss)))
                                .child(
                                  div()
                                    .id(`res-end-${row.address}`)
                                    .ml(6)
                                    .px(5)
                                    .py(1)
                                    .rounded(4)
                                    .flex_none()
                                    .cursor_pointer()
                                    .text_size(11)
                                    .text_color(t.blocked)
                                    .hover((s) => s.bg(t.selected))
                                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                    .on_click((_e, cx) => {
                                      cx.stop_propagation();
                                      this.confirming = [row.address];
                                      cx.notify();
                                    })
                                    .child("End"),
                                ),
                            ),
                          ),
                        );
                    }),
                  ),
                );
            }),
          )
          .when(other.length > 0, (el) => {
            const otherFolded = this.folded.has("other");
            return el.child(
              v_flex()
                .w_full()
                .child(
                  h_flex()
                    .id("group-other")
                    .w_full()
                    .px(12)
                    .py(6)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.toggleFold("other", cx))
                    .child(
                      h_flex()
                        .flex_1()
                        .items_center()
                        .gap(6)
                        .child(div().text_size(10).text_color(t.dim).child(otherFolded ? "▸" : "▾"))
                        .child(div().text_size(11).font_bold().text_color(t.muted).child("Other terminals")),
                    )
                    .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(other.reduce((s, r) => s + r.cpu, 0))))
                    .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(other.reduce((s, r) => s + r.rss, 0)))),
                )
                .when(!otherFolded, (el2) =>
                  el2.children(
                    other.map((row) =>
                      h_flex()
                        .id(`res-other-${row.address}`)
                        .w_full()
                        .pl(28)
                        .pr(12)
                        .py(4)
                        .child(div().flex_1().text_size(12).text_color(t.foreground).child(row.label))
                        .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(row.cpu)))
                        .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(row.rss))),
                    ),
                  ),
                ),
            );
          })
          .child(
            v_flex()
              .w_full()
              .child(
                h_flex()
                  .id("group-herdr")
                  .w_full()
                  .px(12)
                  .py(6)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.toggleFold("herdr", cx))
                  .child(
                    h_flex()
                      .flex_1()
                      .items_center()
                      .gap(6)
                      .child(div().text_size(10).text_color(t.dim).child(this.folded.has("herdr") ? "▸" : "▾"))
                      .child(div().text_size(11).font_bold().text_color(t.muted).child("Herdr")),
                  )
                  .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtCpu(herdr.cpu)))
                  .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.muted).child(fmtMem(herdr.rss))),
              )
              .when(!this.folded.has("herdr"), (el) =>
                el.child(
                  h_flex()
                    .w_full()
                    .pl(28)
                    .pr(12)
                    .py(4)
                    .child(div().flex_1().text_size(12).text_color(t.dim).child("Herdr.app & herdr-core"))
                    .child(div().w(54).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtCpu(herdr.cpu)))
                    .child(div().w(72).flex_none().flex().justify_end().text_size(11).text_color(t.dim).child(fmtMem(herdr.rss))),
                ),
              ),
          ),
      );
  }

  allHerdrRows(snap) {
    const rows = [];
    for (const proj of snap?.projects ?? []) {
      for (const wt of proj.worktrees ?? []) {
        for (const row of wt.terminals ?? []) rows.push(row);
      }
    }
    return rows;
  }

  confirmMessage(addresses, snap) {
    const rows = this.allHerdrRows(snap);
    const byAddr = new Map(rows.map((r) => [r.address, r]));
    const n = addresses.length;
    const base = `End ${n} ${n === 1 ? "terminal" : "terminals"} and their processes?`;
    const runningAgent = addresses
      .map((a) => byAddr.get(a)?.agent)
      .find((ag) => isAgentName(ag));
    return runningAgent ? `${base} One is running ${agentDisplayName(runningAgent)}.` : base;
  }

  togglePtyDetails(address, cx) {
    if (this.unfoldedPtys.has(address)) {
      this.unfoldedPtys.delete(address);
      cx.notify();
      return;
    }
    this.unfoldedPtys.add(address);
    cx.notify();
    if (this.ptyDetails.has(address)) return;
    cx.spawn(async (cx) => {
      try {
        const res = await exec("hc", ["get", address, "--json"], { timeout: 5000 });
        if (res.code === 0 && res.stdout) {
          this.ptyDetails.set(address, JSON.parse(res.stdout));
        }
      } catch {}
      cx.notify();
    });
  }

  endTerminals(addresses, snap, cx) {
    if (this.ending || !addresses.length) return;
    const rows = this.allHerdrRows(snap);
    const labelOf = new Map(rows.map((r) => [r.address, r.label]));
    this.ending = true;
    this.endErrors = [];
    cx.notify();

    cx.spawn(async (cx) => {
      const queue = [...addresses];
      const errors = [];
      const workerCount = Math.min(4, queue.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const addr = queue.shift();
          try {
            const res = await exec("hc", ["kill", addr], { timeout: 5000 });
            if (res.code !== 0) {
              const msg = (res.stderr || `exit ${res.code}`).trim();
              errors.push(`${labelOf.get(addr) || addr}: ${msg}`);
            }
          } catch (err) {
            errors.push(`${labelOf.get(addr) || addr}: ${err?.message || "failed"}`);
          }
        }
      });
      await Promise.all(workers);

      this.selected.clear();
      this.confirming = null;
      this.ending = false;
      this.endErrors = errors;
      setShared("orca.resources.refresh", { at: Date.now() });
      cx.notify();
    });
  }

  renderPtysTab(t, snap) {
    const projects = Array.isArray(snap?.projects) ? snap.projects : [];
    const allRows = this.allHerdrRows(snap);
    const count = snap?.count ?? allRows.length;
    const validAddrs = new Set(allRows.map((r) => r.address));
    const selectedAddrs = Array.from(this.selected).filter((a) => validAddrs.has(a));
    const allSelected = allRows.length > 0 && selectedAddrs.length === allRows.length;

    return v_flex()
      .w_full()
      .flex_1()
      .overflow_hidden()
      .child(
        v_flex()
          .w_full()
          .px(12)
          .py(10)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .text_size(12)
              .font_bold()
              .text_color(t.foreground)
              .child(`${count} Herdr terminals on this computer`),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .child(`Last observed ${formatObservedTime(snap?.at)}`),
          )
          .child(
            h_flex()
              .w_full()
              .items_center()
              .justify_between()
              .pt(2)
              .child(
                h_flex()
                  .id("pty-select-all")
                  .items_center()
                  .gap(6)
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    if (allSelected) this.selected.clear();
                    else for (const r of allRows) this.selected.add(r.address);
                    cx.notify();
                  })
                  .child(
                    div()
                      .w(14)
                      .h(14)
                      .rounded(3)
                      .border(1)
                      .border_color(allSelected ? t.accent : t.border)
                      .when(allSelected, (el) => el.bg(t.accent))
                      .flex()
                      .items_center()
                      .justify_center()
                      .text_size(10)
                      .text_color(t.foreground)
                      .child(allSelected ? "✓" : ""),
                  )
                  .child(div().text_size(11).text_color(t.muted).child("Select all")),
              )
              .child(
                (() => {
                  const base = div()
                    .id("pty-end-selected")
                    .px(8)
                    .py(3)
                    .rounded(4)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(selectedAddrs.length > 0 ? t.blocked : t.dim)
                    .bg(t.raised)
                    .child(`End selected (${selectedAddrs.length})`);
                  return selectedAddrs.length > 0
                    ? base.cursor_pointer().on_click((_e, cx) => {
                        this.confirming = selectedAddrs;
                        cx.notify();
                      })
                    : base;
                })(),
              ),
          ),
      )
      .child(this.renderConfirmAndErrors(t, snap))
      .child(
        v_flex()
          .w_full()
          .flex_1()
          .overflow_y_scroll()
          .children(
            projects.map((proj) => {
              const projCount = (proj.worktrees ?? []).reduce(
                (s, w) => s + (w.terminals?.length ?? 0),
                0,
              );
              return v_flex()
                .w_full()
                .child(
                  h_flex()
                    .w_full()
                    .px(12)
                    .py(6)
                    .items_center()
                    .justify_between()
                    .child(
                      div()
                        .text_size(11)
                        .font_bold()
                        .text_color(t.muted)
                        .child(proj.name.toUpperCase()),
                    )
                    .child(div().text_size(11).text_color(t.dim).child(String(projCount))),
                )
                .children(
                  (proj.worktrees ?? []).map((wt) =>
                    v_flex()
                      .w_full()
                      .child(
                        h_flex()
                          .w_full()
                          .pl(20)
                          .pr(12)
                          .py(4)
                          .items_center()
                          .justify_between()
                          .child(div().text_size(11).text_color(t.muted).child(wt.name))
                          .child(div().text_size(11).text_color(t.dim).child(String(wt.terminals?.length ?? 0))),
                      )
                      .children(
                        (wt.terminals ?? []).map((row) => {
                          const checked = this.selected.has(row.address);
                          const unfolded = this.unfoldedPtys.has(row.address);
                          const detail = this.ptyDetails.get(row.address);
                          const argvStr = Array.isArray(detail?.foreground?.argv)
                            ? detail.foreground.argv.join(" ")
                            : "";
                          return v_flex()
                            .w_full()
                            .child(
                              h_flex()
                                .w_full()
                                .pl(24)
                                .pr(12)
                                .py(4)
                                .items_center()
                                .gap(6)
                                .hover((s) => s.bg(t.hover))
                                .child(
                                  div()
                                    .id(`pty-check-${row.address}`)
                                    .w(14)
                                    .h(14)
                                    .flex_none()
                                    .rounded(3)
                                    .border(1)
                                    .border_color(checked ? t.accent : t.border)
                                    .when(checked, (el) => el.bg(t.accent))
                                    .cursor_pointer()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_size(10)
                                    .text_color(t.foreground)
                                    .on_click((_e, cx) => {
                                      if (checked) this.selected.delete(row.address);
                                      else this.selected.add(row.address);
                                      cx.notify();
                                    })
                                    .child(checked ? "✓" : ""),
                                )
                                .child(
                                  div()
                                    .id(`pty-fold-${row.address}`)
                                    .px(2)
                                    .cursor_pointer()
                                    .text_size(11)
                                    .text_color(t.dim)
                                    .on_click((_e, cx) => this.togglePtyDetails(row.address, cx))
                                    .child(unfolded ? "▾" : "›"),
                                )
                                .child(
                                  div()
                                    .flex_1()
                                    .text_size(12)
                                    .text_color(t.foreground)
                                    .child(row.label),
                                )
                                .child(
                                  div()
                                    .id(`pty-jump-${row.address}`)
                                    .px(4)
                                    .cursor_pointer()
                                    .text_size(11)
                                    .text_color(t.muted)
                                    .hover((s) => s.text_color(t.foreground))
                                    .on_click(() => run("pane.focus", { terminal: row.address }))
                                    .child("↗"),
                                )
                                .child(
                                  div()
                                    .id(`pty-end-${row.address}`)
                                    .px(6)
                                    .py(2)
                                    .rounded(4)
                                    .cursor_pointer()
                                    .text_size(11)
                                    .text_color(t.blocked)
                                    .hover((s) => s.bg(t.selected))
                                    .on_click((_e, cx) => {
                                      this.confirming = [row.address];
                                      cx.notify();
                                    })
                                    .child("End"),
                                ),
                            )
                            .when(unfolded, (el) =>
                              el.child(
                                v_flex()
                                  .pl(46)
                                  .pr(12)
                                  .pb(6)
                                  .gap(2)
                                  .text_size(11)
                                  .text_color(t.dim)
                                  .child(`Address: ${row.address} · PID: ${detail?.pid ?? row.pid ?? "—"}`)
                                  .when(Boolean(detail?.cwd), (d) => d.child(`Folder: ${detail.cwd}`))
                                  .when(Boolean(argvStr), (d) => d.child(`Program: ${argvStr}`))
                                  .when(Boolean(detail?.created_ms), (d) =>
                                    d.child(`Started: ${formatObservedTime(detail.created_ms)}`),
                                  ),
                              ),
                            );
                        }),
                      ),
                  ),
                );
            }),
          ),
      );
  }

  render() {
    const overlay = props()?.overlay;
    if (!overlay) return div();

    const t = theme();
    const height = props()?.height ?? 400;
    const snap = shared("orca.resources") ?? null;

    const card = v_flex()
      .w(CARD_W)
      .flex_none()
      .max_h(height)
      .bg(t.popover)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.renderHeader(t, snap))
      .child(
        this.tab === "ptys"
          ? this.renderPtysTab(t, snap)
          : this.renderResourcesTab(t, snap),
      );

    return div()
      .id("resources-root")
      .w_full()
      .h(height)
      .flex()
      .items_end()
      .text_size(12)
      .text_color(t.foreground)
      .on_mouse_down("left", () => this.close(overlay))
      .child(card);
  }
}
