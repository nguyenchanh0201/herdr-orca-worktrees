import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme } from "herdr";

// A pill is half its height, so the track and the fill share this. (Module constants are named per
// file: the tests run a mod and its ui files as one script, where a repeated name would clash.)
const PROGRESS_BAR_HEIGHT = 6;
const PROGRESS_BAR_RADIUS = PROGRESS_BAR_HEIGHT / 2;

// A bar filled to `pct` (0-100) in `tone` (a theme color key). Fixed `width` px, or the full row.
export function progressBar(pct, { tone = "muted", width } = {}) {
  const t = theme();
  const track = h_flex().h(PROGRESS_BAR_HEIGHT).rounded(PROGRESS_BAR_RADIUS).bg(t.border).overflow_hidden();
  return (width ? track.w(width).flex_none() : track.w_full())
    .when(pct > 0, (el) =>
      el.child(div().h_full().flex_basis(0).flex_grow(pct).rounded(PROGRESS_BAR_RADIUS).bg(t[tone])),
    )
    .when(pct < 100, (el) => el.child(div().h_full().flex_basis(0).flex_grow(100 - pct)));
}
