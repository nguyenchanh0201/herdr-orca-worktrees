import { h_flex, v_flex } from "gpui-base";
import { SPACE } from "./ui/tokens.js";
import { text } from "./ui/atoms/text.js";
import { divider } from "./ui/atoms/divider.js";
import { progressBar } from "./ui/atoms/progress-bar.js";
import { popoverCard } from "./ui/organisms/popover-card.js";
import { windowName, updatedText, barColor } from "./format.js";
import { DETAILS_W } from "./layout.js";
import { providerName, resetLabel } from "./labels.js";
import { providerIcon } from "./provider-icon.view.js";

// One limit of a provider: its name, a full-width bar, then "N% used" and when it resets.
function windowMeter(w, now) {
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
  const resetStr = resetLabel(w.resetsAt, now);
  return v_flex()
    .w_full()
    .gap(SPACE.sm)
    .child(text(windowName(w)))
    .child(progressBar(pct, { tone: barColor(pct) }))
    .child(
      h_flex()
        .w_full()
        .justify_between()
        .child(text(`${pct}% used`, { size: "sm", tone: "muted" }))
        .when(Boolean(resetStr), (el) => el.child(text(resetStr, { size: "sm", tone: "muted" }))),
    );
}

export function renderDetailsCard(view, now, data, p, maxHeight) {
  const card = popoverCard({ width: DETAILS_W, maxHeight });
  if (!p) {
    return card.p(SPACE["2xl"]).child(text("No usage data", { tone: "muted" }));
  }

  const iconEl = providerIcon(view, p.id, "foreground");
  const windows = Array.isArray(p.windows) ? p.windows : [];

  return card.child(
    v_flex()
      .w_full()
      .id("usage-details")
      .flex_shrink(1)
      .min_h(0)
      .overflow_y_scroll()
      .p(SPACE["2xl"])
      .gap(SPACE.xl)
      .child(
        h_flex()
          .w_full()
          .items_center()
          .gap(SPACE.md)
          .when(Boolean(iconEl), (el) => el.child(iconEl))
          .child(
            v_flex()
              .min_w(0)
              .child(text(providerName(p.id), { size: "xl", weight: "semibold" }))
              .child(text(updatedText(data.fetchedAt, now), { size: "sm", tone: "muted" })),
          ),
      )
      .child(divider())
      .when(p.status === "error" && Boolean(p.error), (el) =>
        el.child(text(p.error, { size: "sm", tone: "blocked" })),
      )
      .when(p.status === "ok" && windows.length === 0, (el) =>
        el.child(text("No limits reported", { tone: "muted" })),
      )
      .children(windows.map((w) => windowMeter(w, now))),
  );
}
