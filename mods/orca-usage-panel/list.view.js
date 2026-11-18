import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, setShared, theme } from "herdr";
import { SPACE, ICON, BORDER } from "./ui/tokens.js";
import { text } from "./ui/atoms/text.js";
import { progressBar } from "./ui/atoms/progress-bar.js";
import { iconButton } from "./ui/molecules/icon-button.js";
import { segmentedControl } from "./ui/molecules/segmented-control.js";
import { selectableRow } from "./ui/molecules/selectable-row.js";
import { popoverCard } from "./ui/organisms/popover-card.js";
import { cardHeader } from "./ui/organisms/card-header.js";
import { until, barColor, detailLines } from "./format.js";
import { LIST_W, ROW_H, MINI_BAR_W, PERCENT_W, ROW_INDENT } from "./layout.js";
import { providerName, resetLabel } from "./labels.js";
import { providerIcon } from "./provider-icon.view.js";

const REFRESH_ICON = "orca-icons/refresh.svg";
const MODES = [
  { id: "detailed", label: "Detailed" },
  { id: "compact", label: "Compact" },
];

function headlineWindow(p) {
  const windows = Array.isArray(p?.windows) ? p.windows : [];
  if (windows.length === 0) return null;
  let top = windows[0];
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].usedPercent > top.usedPercent) top = windows[i];
  }
  return top;
}

// The ">" that ends a row.
function chevron() {
  return text("›", { size: "lg", tone: "dim" }).flex_none();
}

function renderHeader(data, mode) {
  return cardHeader({
    title: "Usage",
    aside: [
      text("all agents", { tone: "muted" }),
      iconButton({
        id: "usage-refresh",
        src: REFRESH_ICON,
        busy: data.fetching,
        onClick: () => {
          if (!data.fetching) setShared("orca.usage.refresh", { at: Date.now(), force: true });
        },
      }),
    ],
    below: [
      segmentedControl({
        id: "mode",
        options: MODES,
        value: mode,
        onChange: (id, cx) => {
          setShared("orca.usage.mode", id);
          cx.notify();
        },
      }),
    ],
  });
}

// "--" with no windows, "⚠" on error, or null when the row has numbers to show.
function emptyMark(p) {
  if (p.status === "error") return text("⚠", { tone: "blocked" });
  if (!p.windows?.length) return text("--", { tone: "muted" });
  return null;
}

// A provider row: hover and click go to the view, which owns which row the details card follows.
function providerRow(view, layout, p, selected) {
  return selectableRow(layout, { id: `provider-${p.id}`, selected, ...view.rowEvents(p.id) });
}

function renderCompactRow(view, now, p, selected) {
  const iconEl = providerIcon(view, p.id, "foreground");
  const topWin = headlineWindow(p);
  const pct = topWin ? Math.max(0, Math.min(100, Math.round(topWin.usedPercent))) : null;
  const resetText = topWin ? until(topWin.resetsAt, now) : "";
  const subLabel = p.id === "agy" && topWin?.label ? topWin.label : null;

  return providerRow(
    view,
    h_flex().w_full().h(ROW_H).px(SPACE.xl).gap(SPACE.lg).items_center().justify_between(),
    p,
    selected,
  )
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .items_center()
        .gap(SPACE.lg)
        .when(Boolean(iconEl), (el) => el.child(iconEl))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(SPACE["2xs"])
            .child(text(providerName(p.id), { ellipsis: true }))
            .when(Boolean(subLabel), (el) =>
              el.child(text(subLabel, { size: "sm", tone: "dim", ellipsis: true })),
            ),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .items_center()
        .gap(SPACE.sm)
        .when(Boolean(topWin && resetText), (el) =>
          el.child(text(resetText, { size: "sm", tone: "muted" })),
        )
        .when(p.status === "error", (el) => el.child(text("⚠", { tone: "blocked" })))
        .when(topWin !== null, (el) => el.child(text(`${pct}%`)))
        .when(topWin === null && p.status !== "error", (el) =>
          el.child(text("--", { tone: "muted" })),
        )
        .child(chevron()),
    );
}

// `label  [bar] N%` for one window. A lone item (Antigravity) gives its long label the spare room,
// so the bars line up.
function miniMeter(it, lone) {
  const color = barColor(it.pct);
  return h_flex()
    .min_w(0)
    .when(lone, (el) => el.flex_1())
    .items_center()
    .gap(SPACE.sm)
    .child(
      text(it.label, { size: "sm", tone: "muted" })
        .when(lone, (el) => el.flex_1().min_w(0).truncate())
        .when(!lone, (el) => el.flex_none()),
    )
    .child(progressBar(it.pct, { tone: color, width: MINI_BAR_W }))
    .child(
      text(`${it.pct}%`, { size: "sm", tone: color === "muted" ? "foreground" : color })
        .flex_none()
        .w(PERCENT_W),
    );
}

function renderDetailedRow(view, now, p, selected) {
  const iconEl = providerIcon(view, p.id, "foreground");
  const resetStr = resetLabel(headlineWindow(p)?.resetsAt, now);
  const mark = emptyMark(p);
  const lines = detailLines(p);

  return providerRow(
    view,
    h_flex().w_full().px(SPACE.xl).py(SPACE.md).gap(SPACE.md).items_center(),
    p,
    selected,
  )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(SPACE.xs)
        .child(
          h_flex()
            .w_full()
            .items_center()
            .gap(SPACE.lg)
            .child(iconEl ?? div().w(ICON.lg).flex_none())
            .child(text(providerName(p.id), { size: "lg" }).flex_none())
            .when(Boolean(resetStr), (el) =>
              el.child(text(resetStr, { size: "sm", tone: "muted", ellipsis: true }).min_w(0)),
            ),
        )
        .when(Boolean(mark), (el) => el.child(h_flex().pl(ROW_INDENT).child(mark)))
        .children(
          lines.map((line) =>
            h_flex()
              .w_full()
              .pl(ROW_INDENT)
              .gap(SPACE.lg)
              .items_center()
              .children(line.map((it) => miniMeter(it, line.length === 1))),
          ),
        ),
    )
    .child(chevron());
}

function renderUnavailableRow(view, p) {
  const iconEl = providerIcon(view, p.id, "dim");
  return h_flex()
    .w_full()
    .h(ROW_H)
    .px(SPACE.xl)
    .gap(SPACE.lg)
    .items_center()
    .when(Boolean(iconEl), (el) => el.child(iconEl))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(SPACE["2xs"])
        .child(text(providerName(p.id), { tone: "dim", ellipsis: true }))
        .child(text(p.error || "Unavailable", { size: "sm", tone: "dim", ellipsis: true })),
    );
}

export function renderListCard(view, now, data, available, unavailable, selectedId, maxHeight) {
  const mode = shared("orca.usage.mode") ?? "compact";
  const renderRow = mode === "detailed" ? renderDetailedRow : renderCompactRow;
  return popoverCard({ width: LIST_W, maxHeight })
    .child(renderHeader(data, mode))
    .child(
      v_flex()
        .w_full()
        .id("usage-list")
        .flex_shrink(1)
        .min_h(0)
        // overflow_y_scrollbar collapses to zero in a content-sized card; the plain scroll doesn't.
        .overflow_y_scroll()
        .py(SPACE.xs)
        .children(available.map((p) => renderRow(view, now, p, p.id === selectedId)))
        .when(unavailable.length > 0, (el) =>
          el.child(
            v_flex()
              .w_full()
              .mt(SPACE.xs)
              .pt(SPACE.xs)
              .border_t(BORDER)
              .border_color(theme().border)
              .children(unavailable.map((p) => renderUnavailableRow(view, p))),
          ),
        ),
    );
}
