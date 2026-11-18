import { theme } from "herdr";

// Gives a row the list-item look and events: pointer cursor, `selected` background, hover background
// otherwise. `onHover(hovered, cx)` and `onClick(e, cx)` are the mod's; the row keeps its own layout.
export function selectableRow(row, { id, selected, onHover, onClick }) {
  const t = theme();
  return row
    .id(id)
    .cursor_pointer()
    .when(selected, (el) => el.bg(t.selected))
    .when(!selected, (el) => el.hover((s) => s.bg(t.selected)))
    .on_hover(onHover)
    .on_click(onClick);
}
