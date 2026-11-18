# ui: the shared component library

Every mod draws with these pieces instead of raw numbers and repeated styling. Atomic design, four layers:

| Layer | Folder | What it is | Example |
|---|---|---|---|
| tokens | `tokens.js` | The only place style numbers live: `SPACE`, `FONT`, `RADIUS`, `ICON`, `BORDER` | `FONT.sm` |
| atoms | `atoms/` | One element, no layout opinion | `text`, `icon`, `divider`, `progressBar` |
| molecules | `molecules/` | Atoms with behavior | `iconButton`, `segmentedControl`, `selectableRow` |
| organisms | `organisms/` | A whole region | `popoverCard`, `cardHeader` |

A mod's `main.js` is the page: state, lifecycle, and composing organisms. A mod keeps its own sizes (a popup's width, a row height) as named constants in a `layout.js` next to its `main.js`.

## Rules

- No number literals in `.text_size()`, `.gap()`, `.p()`, `.rounded()`, `.size()` outside this folder. Name a step from `tokens.js`. A value that is on no scale is a design change: add a step there, once.
- Colors are theme keys, never hex: `text("x", { tone: "muted" })`. Components call `theme()` themselves, so callers don't pass `t`.
- A component takes one options object and returns an element, so the caller can keep chaining layout (`text("x").flex_none()`).
- Add a component when two places need it, not before.
- Module-level constants are named per file (`PROGRESS_BAR_HEIGHT`, not `HEIGHT`): the tests run a mod and its ui files as one script, where a repeated name is an error.
- Named exports only, no default exports.

## How a mod gets it

A mod can't import outside its own folder (`herdr-app check` rejects `../ui/...`). So a mod that uses the library has a symlink `mods/<mod>/ui -> ../../ui` and imports `./ui/atoms/text.js`. `scripts/install.sh` copies with `rsync -L`, so the installed mod holds real files. Run `herdr-app check` on the installed copy (`~/.config/herdr-app/mods/<mod>`), not on the repo folder: the check refuses a symlink that leaves the folder.

Editing `ui/` changes nothing in Herdr until you reinstall the mods that use it.

## Tests

`test/helpers/modsource.js` gives a mod's source to the tests: if the mod has a `ui` link, the whole library comes first, then its `*.view.js` files, then `main.js`.

## Icons

The mods' own SVGs live in `assets/icons/`, not in any mod. `scripts/install.sh` copies them to `~/.config/herdr-app/orca-icons/`, and a mod draws one with `svg("orca-icons/<name>.svg")` (Herdr resolves asset paths from `~/.config/herdr-app`, so any mod can use them). Add a new icon there, not next to a mod.

Exception: `mods/orca-tabs/win-*.svg` stay with that mod. `orca-tabs/main.js` must match Herdr's own `tabs` mod line for line (a test checks it), and that mod references them by its own folder.
