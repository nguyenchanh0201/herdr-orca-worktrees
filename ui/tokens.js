// Design tokens: the one place raw style numbers live. Components and mods name a step
// (`SPACE.md`, `FONT.sm`, `RADIUS.lg`, `ICON.sm`) instead of writing a number. Colors are not here:
// they come from the Herdr theme, by key (`tone: "muted"` -> `theme().muted`).
//
// Scales are fixed on purpose. A value that isn't on a scale is a design change: add a step here.

// Padding, margin and gap (px).
export const SPACE = { "2xs": 2, xs: 4, sm: 6, md: 8, lg: 10, xl: 12, "2xl": 14, "3xl": 16 };

// Text size (px).
export const FONT = { xs: 10, sm: 11, md: 12, lg: 13, xl: 14 };

// Corner radius (px).
export const RADIUS = { sm: 4, md: 6, lg: 8, xl: 10 };

// Icon edge (px).
export const ICON = { xs: 12, sm: 14, md: 16, lg: 20 };

// Every border and divider is one pixel.
export const BORDER = 1;
