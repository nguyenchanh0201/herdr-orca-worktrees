import { div } from "gpui-kit";
import { theme } from "herdr";
import { SPACE, RADIUS } from "../tokens.js";
import { icon } from "../atoms/icon.js";

// A small clickable icon. `hoverBg` is a theme color key. `isolated` keeps a press from reaching the
// element underneath (a strip or card that also reacts to presses).
export function iconButton({ id, src, onClick, busy = false, size = "sm", pad = "xs", hoverBg = "selected", isolated = false }) {
  const t = theme();
  return div()
    .id(id)
    .flex_none()
    .p(SPACE[pad])
    .rounded(RADIUS.sm)
    .cursor_pointer()
    .text_color(t.muted)
    .hover((s) => s.text_color(t.foreground).bg(t[hoverBg]))
    .when(isolated, (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
    .on_click((e, cx) => {
      if (isolated) cx.stop_propagation();
      onClick(e, cx);
    })
    .child(icon(src, { size, spin: busy }));
}
