import { div } from "gpui-kit";
import { theme } from "herdr";
import { BORDER } from "../tokens.js";

// A full-width hairline.
export function divider() {
  return div().w_full().h(BORDER).flex_none().bg(theme().border);
}
