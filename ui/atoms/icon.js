import { svg, image } from "gpui-kit";
import { theme } from "herdr";
import { ICON } from "../tokens.js";

const ICON_SPIN_MS = 900;

// An icon file. `tint: true` draws it as a mask in `tone` (a theme color key, or the parent's text color
// when omitted, so a hovering parent can recolor it); `tint: false` draws it in its own colors.
// `spin` turns it forever, for "busy".
export function icon(src, { size = "md", tone, tint = true, spin = false } = {}) {
  const px = ICON[size];
  if (!tint) return image(src).size(px).flex_none();
  const el = svg(src).size(px).flex_none().when(Boolean(tone), (e) => e.text_color(theme()[tone]));
  return spin ? el.spin(ICON_SPIN_MS) : el;
}
