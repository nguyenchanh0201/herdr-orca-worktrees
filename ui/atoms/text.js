import { div } from "gpui-kit";
import { theme } from "herdr";
import { FONT } from "../tokens.js";

// A run of text. `size` is a FONT step, `tone` a theme color key (foreground, muted, dim, blocked, ...),
// `weight` "regular" | "semibold" | "bold". Returns an element, so callers can keep chaining layout.
export function text(content, { size = "md", tone = "foreground", weight = "regular", ellipsis = false } = {}) {
  return div()
    .text_size(FONT[size])
    .text_color(theme()[tone])
    .when(weight === "semibold", (el) => el.font_semibold())
    .when(weight === "bold", (el) => el.font_bold())
    .when(ellipsis, (el) => el.truncate())
    .child(content);
}
