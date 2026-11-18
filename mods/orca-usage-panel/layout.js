// Sizes this popup owns (px). Spacing, text, radius and icon steps come from ui/tokens.js.
import { SPACE, ICON } from "./ui/tokens.js";

export const LIST_W = 340;
export const DETAILS_W = 300;
export const GAP = SPACE.md;

// A provider row in the compact list, and in the unavailable list.
export const ROW_H = 48;

// The mini bar and the percent beside it in a detailed row.
export const MINI_BAR_W = 28;
export const PERCENT_W = 30;

// Under the icon and its gap: aligns a detailed row's lines with its name.
export const ROW_INDENT = ICON.lg + SPACE.lg;
