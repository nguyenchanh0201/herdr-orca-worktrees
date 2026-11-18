import { v_flex } from "gpui-base";
import { theme } from "herdr";
import { RADIUS, BORDER } from "../tokens.js";

// The floating surface: popover background, border, rounded, clipped. A press on it never reaches
// whatever sits behind (a see-through root that closes the popup on a press).
export function popoverCard({ width, maxHeight }) {
  const t = theme();
  return v_flex()
    .w(width)
    .flex_none()
    .max_h(maxHeight)
    .bg(t.popover)
    .border(BORDER)
    .border_color(t.border)
    .rounded(RADIUS.xl)
    .overflow_hidden()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
}
