import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";
import { SPACE, BORDER } from "../tokens.js";
import { text } from "../atoms/text.js";

// The top of a card: a bold `title`, optional `aside` elements pushed to the right, and optional
// `below` elements (a control row) underneath, all separated from the body by a hairline.
export function cardHeader({ title, aside = [], below = [] }) {
  return v_flex()
    .w_full()
    .flex_none()
    .p(SPACE.xl)
    .gap(SPACE.lg)
    .border_b(BORDER)
    .border_color(theme().border)
    .child(
      h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .child(text(title, { size: "lg", weight: "bold" }))
        .child(h_flex().items_center().gap(SPACE.sm).children(aside)),
    )
    .children(below);
}
