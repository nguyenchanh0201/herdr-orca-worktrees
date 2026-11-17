# Orca chrome polish: bottom bar, usage panel, top sidebar toggle — design

Date: 2026-11-17. Follows the usage meters
(`2026-11-17-usage-meters-design.md`) and sidebar collapse
(`2026-11-17-sidebar-collapse-resize-design.md`), which are built. The
person compared Herdr with Orca side by side and asked to mimic Orca's
behaviour and look in three places.

## Intent

Make the `orca` layout's chrome match Orca:

1. **Bottom bar**: usage on the **left** — `Used  ✳ 52% 2d 4h  ◎ 55% 1d 6h
   ▲ 20% Gemini wk  ⟳` — no "orca" label.
2. **Usage panel** like Orca's: header "Usage · all agents" + refresh, a
   **Detailed / Compact** switch, one row per agent with a `›`, and a side card
   per agent with Session / Weekly / Fable bars ("28% used", "Resets in
   4h 42m").
3. **Sidebar toggle on top**: the ◧ button sits top-left next to the window
   buttons, also when the sidebar is hidden (today it's bottom-left in the
   strip).

## Already done

- agy usage read from `command.data.groups` (commit `04092a9`); agy reports
  Gemini weekly / 5h and Claude-GPT buckets.

## Goals

1. Strip = one row: `orca-usage` on the left (fills), `orca-setup` on the
   right (setup status + Remove), no "orca" label, no bottom-left ◧.
2. Chips: muted **"Used"**, the chips, then a **⟳** button (force refresh).
   Compact chip = Orca's headline; Detailed chip = mini bar + every window.
3. agy chip text like Orca: `20% Gemini wk` (group name without a trailing
   " Models", then `wk` / `5h`).
4. Click the chips → the Orca-style two-pane panel.
5. ◧ at the top-left of the tab bar while the sidebar is hidden; the
   sidebar's own top toggle (shipped `workspace-chrome`) is the one while
   it's shown.

## Non-goals

- "Usage details & history", "Manage Accounts…", "Add another account…"
  (multi-account and cost history) — not drawn.
- Orca's back/forward arrows, Search / Tasks / Automations / Orca Mobile.
- The Projects header icons, the Filter box, and grouping worktrees by state
  (WORKING / NO RECENT UPDATE / DONE) — **open question, not in this spec**
  (asked; awaiting the person's choice).

## Anti-goals

- Editing shipped files. The tab bar change is a copy (`orca-tabs`) used only
  by the `orca` layout.
- A popup that loses its state or flickers when the pointer moves between
  rows.

## Approaches considered

| Part | Picked | Alternative |
|---|---|---|
| Strip | **Row: usage (weight 1) + setup (px 260)** | Keep setup left — not Orca's layout |
| Top toggle | **Copy shipped `tabs` as `orca-tabs`, add ◧ after the window-button gap while the sidebar is hidden** — exact Orca look; a 157-line copy that won't get Herdr's tab-bar updates | Separate block left of `tabs` — no copy, but `tabs` still reserves the window-button gap after it (~76 px empty) |
| Panel | **One popup, two panes** (list left, card right for the selected row) | Two stacked popups like Orca's hover card — Herdr overlays can't be positioned beside another overlay reliably |

The person approved the bottom bar and panel by asking for them; the top
toggle pick (copy `tabs`) is mine, stated in the brainstorm without
objection.

## Design

### 1. Strip layout (`~/.config/herdr-app/layouts/orca.json`)

The bottom row `orca-strip` (28 px) becomes:
`[{ id: "orca-usage", size: { weight: 1 }, content: { mod: "orca-usage" } },
  { <orca-setup block>, size: { px: 260 } }]`. Back up first.

### 2. `orca-setup` (right part)

- Remove the "orca" label and the bottom-left show-sidebar button (and its
  `findNode` / `orca.sidebar.hidden` reads, now unused here).
- Right-aligned: setup status (as today, error colour on error), then
  **Remove** when the focused space is a linked worktree (unchanged).

### 3. `orca-usage` chips (left part)

- Row, left-aligned, `px(10)`, 12 px font: `Used` (`dim`), chips, `⟳`
  (`svg("mods/workspace-chrome/…")` refresh-like icon if one exists, else
  text `⟳`; `muted`, hover `foreground`) → `setShared("orca.usage.refresh",
  { at: Date.now(), force: true })`, spins (`.spin`) while `fetching`.
- Mode: `localStorage` `usage.mode` = `"compact"` (default) | `"detailed"`;
  the panel changes it via `setShared("orca.usage.mode", mode)`; the strip
  copies a changed shared value into `localStorage` (try/catch) and uses it.
- Compact chip: icon + headline (unchanged rules) except agy buckets: label =
  `shortGroup(label) + " " + (minutes === 10080 ? "wk" : minutes === 300 ?
  "5h" : "")`, i.e. `20% Gemini wk`; `shortGroup` = text before ` · `, minus a
  trailing ` Models`.
- Detailed chip: icon, a 48×6 px bar (`border` track, `muted` fill) of the
  most-used window, then every window `"{pct}% {until || short label}"`
  joined with ` · `.
- Click anywhere on chips → panel (below).

### 4. `orca-usage-panel` (Orca's popup)

`openOverlay({ mod: "orca-usage-panel", kind: "popup", width: 760, height:
420 })`. Two panes; draws nothing without `props().overlay`.

- **Left (360 px)**: header `Usage` (bold) + `all agents` (`muted`) + refresh
  icon; a segmented control **Detailed | Compact** (selected = `selected`
  background) → `setShared("orca.usage.mode", …)`; rows (48 px) per available
  provider sorted by highest used %: icon (20 px), name (truncate),
  right-aligned headline reset text (`muted`) + `{pct}%` + `›`. agy rows show
  the headline bucket's full label in two lines as Orca does. Hover or click a
  row selects it (`selected` background); default = first row.
  Unavailable providers last, dim, reason as subtitle, not selectable.
- **Right (400 px)**: card for the selected provider: icon + name, `Updated
  {just now | Nm ago}` (right, `muted`); an inner rounded box (`raised`
  background, `border`) titled **Default account**; per window: name
  (`Session` for 300, `Weekly` for 10080, `Fable`, else the bucket label),
  a full-width 6 px bar (track `border`; fill `muted` below 80, `ansi3` ≥ 80,
  `ansi1` ≥ 90), then `{pct}% used` left and `Resets in {until}` /
  `Resets now` right (`muted`). Error → its text in `blocked` above the box.
  `ok` with no windows → "No limits reported".

### 5. Top sidebar toggle (`mods/orca-tabs`)

- Copy `~/.config/herdr-app/mods/tabs/` (`main.js`, `mod.json` with title
  `"Tabs (orca)"`, its svgs) into the repo as `mods/orca-tabs/`; asset paths
  `mods/tabs/…` → `mods/orca-tabs/…`. Header comment: copied from Herdr
  0.1.16 `tabs`, with the one change below; re-copy on Herdr updates.
- Change: when `sidebar?.hidden`, the first child (before `tab-scroll`, after
  the `pl(lightsPadding)` gap) is a 26 px button with
  `svg("mods/workspace-chrome/sidebar.svg")` → `run("layout.show", { id:
  "sidebar" })`. Nothing else differs.
- `orca.json`: the tabs block `content.mod` `"tabs"` → `"orca-tabs"`.
- `install.sh` default list adds `orca-tabs`.
- `projects`' hide logic and `cmd-b` are unchanged; the `orca.sidebar.hidden`
  nudge now makes `orca-tabs` redraw.

## Testing

- `node --test`: `shortGroup` / agy compact label (`"Gemini Models · Weekly
  Limit Remaining"` + 10080 → `20% Gemini wk`; one-group label without
  ` · `; 5h; unknown window → no suffix); detailed chip text for 2 windows;
  panel window naming (300 → Session, 10080 → Weekly, Fable, bucket);
  "Updated" text (0–59 s → just now, else `Nm ago`). Pure helpers live in
  `src/usage/format.js` with ESM copies in the mods (the existing copy-match
  test covers them).
- A test that `mods/orca-tabs/main.js` differs from the shipped
  `~/.config/herdr-app/mods/tabs/main.js` only in the marked block and asset
  paths (skipped when the shipped file is absent).
- `herdr-app check` on `orca-usage`, `orca-usage-panel`, `orca-setup`,
  `orca-tabs`.
- Manual: strip shows `Used ✳ … ◎ … ▲ 20% Gemini wk ⟳` at left, setup/Remove
  at right, no "orca"; ⟳ spins then updates; panel matches Orca's (rows,
  `›`, side card with Session/Weekly/Fable, Detailed/Compact switches the
  chips and survives a restart); hide the sidebar (top toggle or cmd-b) → ◧
  appears top-left right after the window buttons, no gap; click → sidebar
  back; `main` layout unchanged.

## Review notes

Builder check (2026-11-17): nothing important left. Settled details:
- Panel window naming checks the `Fable` label before the 10080 → `Weekly`
  rule (Fable is also 10080 min).
- The strip publishes its saved mode to `orca.usage.mode` on start, so the
  panel's switch shows the right side after a restart.
- `orca-tabs` keeps its own per-space Files/Changes panel memory (starts
  fresh once; not shared with `main`) — accepted.
- Chip fitting measures chips by mode: Detailed chips are wider (agy can have
  4+ windows); drop lowest-used chips until they fit.
- The 760×420 popup opens at the pointer from the bottom strip; confirm it
  stays on screen in the manual check (shrink width if not).

## Left to the builder

- Exact paddings/radii within theme colours; the refresh icon choice.
