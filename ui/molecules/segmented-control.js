import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";
import { SPACE, RADIUS, FONT, BORDER } from "../tokens.js";

// A row of mutually exclusive choices. `options` is [{ id, label }]; `onChange(id, cx)` fires on a press.
export function segmentedControl({ id, options, value, onChange }) {
  const t = theme();
  return h_flex()
    .w_full()
    .p(SPACE["2xs"])
    .gap(SPACE["2xs"])
    .rounded(RADIUS.md)
    .bg(t.raised)
    .border(BORDER)
    .border_color(t.border)
    .children(
      options.map((opt) => {
        const active = value === opt.id;
        return div()
          .id(`${id}-${opt.id}`)
          .flex_1()
          .py(SPACE.xs)
          .rounded(RADIUS.sm)
          .text_center()
          .text_size(FONT.sm)
          .cursor_pointer()
          .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => onChange(opt.id, cx))
          .child(opt.label);
      }),
    );
}
