# Usage Panel Orca Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the usage popup look and sit like Orca's: a compact list card above the status bar, the details as a separate floating card, Detailed/Compact changing the list rows, and the whole thing scaling with the window.

**Architecture:** The pure formatting helpers live in `src/usage/format.js` (CJS, unit-tested). ESM copies of that file sit in `mods/orca-usage/format.js` and `mods/orca-usage-panel/format.js`, and `test/usage-mods.test.js` checks the copies match. The strip (`mods/orca-usage`) opens a borderless popup placed from its own bounds. The panel (`mods/orca-usage-panel`) draws two bottom-aligned cards on a transparent root.

**Tech Stack:** Node 24, `node:test`, Herdr.app mods (`gpui-kit`, `gpui-base`, `herdr`).

**Spec:** `docs/superpowers/specs/2026-11-17-usage-panel-orca-layout-design.md`

## Global Constraints

- Hovering a row must never change the list card's size or position.
- The popup must not cover the status bar.
- Bar and % colors: red (`ansi1`) at 80% and up, yellow (`ansi3`) at 60% and up, otherwise `muted`.
- The list card is about 340 px wide, the details card about 300 px, with an 8 px gap between them.
- Out of scope: "Usage details & history", "Manage Accounts…", and the status-bar chips (their render stays as is).
- Commits: no AI co-author trailer.

## Review Focus

- Small window (under 648 px wide or short): the cards stack and scroll, and nothing goes off screen. Covered by Task 3, manual checks 4 and 5.
- A click on the transparent area closes the popup; a click on a card doesn't. Covered by Task 3, manual check 3.
- A provider with no windows, or with an error, in Detailed mode: the row shows `--` or `⚠` and no empty bar line. Covered by Task 1 (`detailLines` returns `[]`) and Task 3, manual check 6.
- Moving the mouse down the Detailed list doesn't flip the selection back and forth. Covered by Task 3, manual check 2.
- The strip's `bounds` are missing on the very first click (not painted yet): fall back to the pointer. Covered by Task 2 Step 2.

---

### Task 1: Format helpers for Detailed rows and the new colors

**Files:**
- Modify: `src/usage/format.js` (`barColor`; add `windowShort`, `detailLines`)
- Modify: `mods/orca-usage/format.js` and `mods/orca-usage-panel/format.js` (the same changes, as ESM exports)
- Test: `test/usage-format.test.js`, `test/usage-mods.test.js`

**Interfaces:**
- Produces:
  - `barColor(pct: number): "ansi1" | "ansi3" | "muted"`
  - `windowShort(w: {label, minutes}): string`: `"Fable"` when `label === "Fable"` (Fable is weekly; the label wins, as in `windowName`), otherwise `"5h"` when `minutes === 300`, `"wk"` when `minutes === 10080`, otherwise `w.label`.
  - `detailLines(p: {id, windows}): Array<Array<{ label: string, pct: number }>>`. `pct` is rounded and clamped to 0–100. For `p.id === "agy"`, there is one line per window, labeled with the full `w.label`. For every other provider, there is one line holding every window, labeled with `windowShort(w)`. With no windows, it returns `[]`.

- [ ] **Step 1: Write the failing tests** in `test/usage-format.test.js`:

```js
test("barColor: red from 80, yellow from 60", () => {
  assert.equal(barColor(59), "muted");
  assert.equal(barColor(60), "ansi3");
  assert.equal(barColor(79), "ansi3");
  assert.equal(barColor(80), "ansi1");
});

test("windowShort", () => {
  assert.equal(windowShort({ label: "Session", minutes: 300 }), "5h");
  assert.equal(windowShort({ label: "Weekly", minutes: 10080 }), "wk");
  assert.equal(windowShort({ label: "Fable", minutes: 10080 }), "Fable"); // label wins
  assert.equal(windowShort({ label: "Pro", minutes: 0 }), "Pro");
});

test("detailLines: one line for claude/codex, one per window for agy", () => {
  const w = (label, minutes, usedPercent) => ({ label, minutes, usedPercent, resetsAt: null });
  assert.deepEqual(
    detailLines({ id: "claude", windows: [w("5h", 300, 85.4), w("Weekly", 10080, 64), w("Fable", 10080, 120)] }),
    [[{ label: "5h", pct: 85 }, { label: "wk", pct: 64 }, { label: "Fable", pct: 100 }]]
  );
  assert.deepEqual(
    detailLines({ id: "agy", windows: [w("Gemini Models · Weekly Limit Remaining", 10080, 27), w("Gemini 4 Argon", 0, -3)] }),
    [[{ label: "Gemini Models · Weekly Limit Remaining", pct: 27 }], [{ label: "Gemini 4 Argon", pct: 0 }]]
  );
  assert.deepEqual(detailLines({ id: "codex", windows: [] }), []);
  assert.deepEqual(detailLines({ id: "codex" }), []);
});
```

Delete the old `barColor maps usage percentage…` test. In `test/usage-mods.test.js`, set `barColors` to `[59, 60, 79, 80]`. Add parity loops for `windowShort` and `detailLines` over the inputs above, comparing each mod copy against `cjsFormat`.

- [ ] **Step 2: Run the tests**: `npm test`. Expected: FAIL, because `windowShort` and `detailLines` don't exist and the old `barColor` returns `muted` at 60.

- [ ] **Step 3: Implement** the three functions in `src/usage/format.js` and export them. Paste the same bodies into both mod `format.js` files as `export function`.

- [ ] **Step 4: Run the tests**: `npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usage/format.js mods/orca-usage/format.js mods/orca-usage-panel/format.js test/usage-format.test.js test/usage-mods.test.js
git commit -m "feat: usage format helpers for detailed rows"
```

### Task 2: Strip opens a borderless popup above itself

**Files:**
- Modify: `mods/orca-usage/main.js:164-170` (the chips row's click handler)

**Interfaces:**
- Produces the overlay spec the panel relies on: `kind: "popup"`, `frame: "none"`, `width: 0.7`, `height: 0.85`. The panel fills it and closes itself with `closeOverlay(props().overlay)`.

- [ ] **Step 1: Find out how `at` places a popup.** Temporarily open with `at: { x: 0, y: 0 }`, install it (`bash scripts/install.sh orca-usage`), click the chips, and see where the popup lands: is `{x, y}` its top-left corner or its bottom-left? Write down the answer as a one-line comment above the call. Also note whether a click outside the popup (on the terminal) still closes it with `frame: "none"`.

- [ ] **Step 2: Open from the strip's bounds.** Replace the `on_click` handler with `on_mouse_down("left", (e, cx) => …)`, so the event carries `bounds` (`{x, y, width, height}`, relative to the window). Use `at` so the popup's bottom edge sits at `e.bounds.y` and its left edge at `e.bounds.x`. If `at` is the top-left corner, the panel's root must bottom-align its cards, so the cards still sit on the strip. When `e.bounds` is missing, omit `at` (the pointer). Keep `cx.stop_propagation()` on the refresh button.

- [ ] **Step 3: Check it**: `bash scripts/install.sh orca-usage && herdr-app check ~/.config/herdr-app/mods/orca-usage`. Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add mods/orca-usage/main.js
git commit -m "feat: usage popup opens borderless above the strip"
```

### Task 3: Panel draws Orca's two cards and Detailed rows

**Files:**
- Modify: `mods/orca-usage-panel/main.js` (the whole render tree; keep `init`, `iconFor`, `DISPLAY_NAMES`, `headlineWindow`, `resetLabel`)

**Interfaces:**
- Consumes: `barColor`, `detailLines`, `windowName`, `updatedText` and `until` from `./format.js` (Task 1), and the overlay spec from Task 2.

- [ ] **Step 1: Root.** A transparent `h_flex().size_full()` with `.id("usage-root")`. It tracks its width and height from `on_size_change` (start at 0 and redraw when they change). It bottom-aligns (`items_end`) and left-aligns its content, and closes the popup on `on_mouse_down("left", …)` with `closeOverlay(props().overlay)`. Each card calls `cx.stop_propagation()` on its own `on_mouse_down("left", …)`. Remove the fixed `h(400)` and the comment about it.

- [ ] **Step 2: Arrangement.** When the width is 648 px or more (340 + 8 + 300), the list card and the details card sit side by side, both bottom-aligned, gap 8. Below that, they stack in a `v_flex` with the details card on top and the list card under it, gap 8. Each card is `bg(t.popover)`, `border(1)`, `border_color(t.border)`, `rounded(10)`, `overflow_y_scrollbar()`, and `max_h`: the root height when side by side, half of it when stacked.

- [ ] **Step 3: List card** (`w(340)`): keep today's header (Usage · all agents · refresh) and the Detailed/Compact switch. Rows:
  - **Compact:** unchanged from today.
  - **Detailed:** `v_flex` row `py(8)` `px(12)`, with the same hover and click selection as today (`on_hover` on entry only).
    - Line 1: a 20 px icon, the name (`text_size(13)`, foreground), and "Resets in …" for `headlineWindow(p)` (muted, `text_size(11)`), with `›` (dim) on the right, vertically centered on the whole row.
    - Then each line from `detailLines(p)`, indented under the name (`pl(30)`). Each item is `label` (muted, `text_size(11)`, truncate), a 48×6 bar (`border` track, fill `t[barColor(pct)]`, same flex-grow trick as the details card), and `pct%`: foreground when `barColor(pct) === "muted"`, otherwise `t[barColor(pct)]`. Items on a line are 10 px apart.
    - A provider with no windows shows `--` (or `⚠` on error) in place of the lines.
  - Unavailable providers: unchanged.

- [ ] **Step 4: Details card** (`w(300)`, `p(14)`, gap 12):
  - Header: icon, name (`text_size(14)`, semibold), and `updatedText(...)` on the line under the name (muted, `text_size(11)`).
  - Then a 1 px `border` divider.
  - Then each window as today: `windowName(w)`, a 6 px bar, and "N% used" with "Resets in …" on the right. The bar fill uses `t[barColor(pct)]`.
  - The error text stays. The "Default account" box and its wrapper go away. With no provider, the card shows "No usage data".

- [ ] **Step 5: Check it**: `bash scripts/install.sh orca-usage-panel && herdr-app check ~/.config/herdr-app/mods/orca-usage-panel && npm test`. Expected: no errors, all tests pass.

- [ ] **Step 6: Manual checks** (stop and ask the person to look; compare against the Orca screenshots in the conversation):
  1. Click the chips: the list card sits right above the status bar without covering "Used", and the details card floats to its right, bottom edges level.
  2. Detailed: Claude shows `5h ▬ 85%  wk ▬ 64%  Fable ▬ 0%` with red and yellow; Antigravity shows one line per limit. Moving the mouse slowly down the list selects each row once, with no flicker. Compact restores the one-line rows.
  3. A click in the empty area beside the cards closes the popup; a click on a card doesn't; Esc closes it.
  4. Shrink the window under about 650 px wide: the details card moves above the list.
  5. Shrink the window's height: both cards scroll and stay on screen.
  6. With a provider in error, or with no limits: the row shows `⚠` or `--` and the details card shows the error text.

- [ ] **Step 7: Commit**

```bash
git add mods/orca-usage-panel/main.js
git commit -m "feat: orca-style two-card usage panel with detailed rows"
```
