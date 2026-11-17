# Project icons, rename and cleaner worktree names

## Why

In the projects sidebar, projects are hard to tell apart. Every header is just bold text, and three of them start with `Coduct.CTM.` and get cut off (`Coduct.CTM.AdminP…`). Worktree rows such as `nguyenchanh0201/feat-CT…` spend their width on the GitHub login. Orca solves this with an icon per project and with renamable projects. We match that.

## Goals

- Each project header shows a 16 px icon before its name, picked in this order:
  1. **custom**: an image the person chose;
  2. **repo**: an icon file in the repo (Orca's list, below);
  3. **github**: the `origin` remote's owner avatar, unless another saved project has the same owner;
  4. **letter**: a coloured letter badge.
- The letter is the first letter of the last `.`-separated part of the display name, upper-cased: `Coduct.CTM.AdminPortal` → **A**, `Coduct.CTM.UserApp` → **U**, `herdr-orca-worktrees` → **H**. The colour comes from a hash of the project path into a fixed palette, so it stays the same across restarts.
- The project header's right-click menu gets **Change icon…** and **Rename…**.
- Worktree rows drop a leading `<login>/` from branch names when `<login>` is one of the person's GitHub logins.
- A project header's `+` shows only while the pointer is over that header. The count stays.

## Non-goals

- Orca's website-favicon source (`package.json` `homepage`).
- Dragging an image onto the sidebar, and a file-picker dialog (Herdr has `pickFolder` only).
- Icons for machine groups and the "Other" group.
- Renaming worktrees or branches; this is display only.
- Changing what the status bar or the Orca app shows.

## Anti-goals

- No network access from the sidebar's render path, and no re-downloading on every start. An icon is fetched once and stored.
- A failed fetch, or a missing or corrupt icon file, never breaks the sidebar. It falls back to the letter badge.
- Never write into the repo. Icons are copied out of it, never into it.
- Never touch the login part of a branch name that isn't one of the person's logins (for example `feat/…` and `combo/…` stay as they are).

## Constraints

- Mods can't fetch or read arbitrary files. Herdr's `image(path)` loads only paths relative to `~/.config/herdr-app` (verified: `data/x.png` renders, an absolute path doesn't). So the Node CLI (`bin/orca-wt.js`, `src/projects.js`) does all fetching and copying, into `~/.config/herdr-app/data/project-icons/` (respect `HERDR_APP_HOME`).
- Herdr shows a `data/` image a frame after the first render. That's fine.
- GPUI has no group-hover, so `+`-on-hover needs per-header hover state (`on_hover`).
- `projects.json` stays backward compatible: entries are `{ path }` today. New fields are optional, and a missing field means "not chosen".

## Approaches

- **A. CLI resolves and stores, sidebar only draws (picked).** `orca-wt` finds the icon, copies or downloads it into Herdr's `data/`, and records it in `projects.json`. `projects list` returns `name`, `icon`, `letter` and `color`. The sidebar draws `image(icon)` or the badge. This keeps the IO in the tested Node code, as the rest of the project does.
- B. The sidebar works out icons itself through `exec` of `curl` and `cp`. Rejected: it puts IO and error handling in untested mod code, and repeats it in every mod.
- C. Use only GitHub avatars, as a first step. Rejected: the three CODUCT repos would share one avatar, which defeats the point.

## Design

### Data (`projects.json` entry)

```json
{ "path": "/…/Coduct.CTM.AdminPortal", "name": "Admin Portal",
  "icon": { "source": "github", "file": "data/project-icons/<sha1(path)>-<ms>.png" } }
```

- `name`: optional. Absent or empty means the folder name.
- `icon.source`: `"custom" | "repo" | "github" | "letter"`. `icon.file` is present unless the source is `letter`.
- With no `icon` field, the project hasn't been resolved yet.
- A chosen `letter` is stored as `{ source: "letter" }`, so auto-resolve doesn't override it.

### CLI (`src/projects.js`, `bin/orca-wt.js`)

- **`projects list`** returns, per project: `path`, `exists`, `name` (display name) and `icon` (relative file or `null`). It doesn't fetch anything. The letter and colour are worked out in the mod (see Sidebar), so unsaved repo groups get them too.
- **`projects resolve-icons`**: for every project with no `icon`, try repo, then GitHub, then fall back to `{ source: "letter" }`. Save, and print the updated list.
  - **repo**: Orca's candidates, at most 256 KB, first match wins. The names are `favicon`, `public/favicon`, `app/favicon`, `app/icon`, `src/favicon`, `src/app/icon`, `assets/favicon`, `assets/icon`, `static/favicon`, `logo`, `public/logo`, `public/icon`, `src-tauri/icons/icon`, `app-icon` and `icon`, each with `.png` or `.webp`. Skip Orca's `index.html` parsing (shortcut).
  - **github**: skipped when two or more saved projects share the same owner (case-insensitive). Shared-owner projects fall through to their letter badges, so the three `CODUCT` repos become U, S and A. *(Person's decision.)* Otherwise, parse the `origin` URL (ssh, https, and ssh host aliases such as `github-nguyenchanh0201`, whose owner is the first path part). Fetch `https://github.com/<owner>.png?size=64` with Node's `fetch`, a 10 s timeout, at most 256 KB, and a PNG or JPEG magic-byte check.
  - Write to `<herdr home>/data/project-icons/<sha1(path)>-<Date.now()>.<ext>` (temp file, then rename), and delete the project's previous icon file. *(Builder-check call: the name carries a version because Herdr may cache an image by path.)*
  - A download that fails (offline, timeout, too big, not an image) saves **no** `icon`, so the next sidebar start tries again; the sidebar shows the letter meanwhile. Only a deliberate choice, or "no repo file and no usable GitHub owner" (no remote, or a shared owner), stores `{ source: "letter" }`. *(Builder-check call.)*
- **`projects set-icon <path> <source> [value]`**:
  - `source` `github` or `repo` re-resolves from that source. If that fails, return an error and leave the stored icon unchanged.
  - `letter` stores `{ source: "letter" }`.
  - `custom <file|url>` copies or downloads, with the same limits and magic check (PNG, JPEG or WebP).
- **`projects rename <path> [name]`**: sets the name, or clears it when the name is empty or missing.
- **`projects logins`**: the user names under every host in `~/.config/gh/hosts.yml`, read without going online (with a minimal YAML parse using the existing `yaml` dependency). Returns `[]` if the file is missing.
- Pure helpers in `src/projects.js`, unit-tested: `ownerFromRemote(url)`, `repoIconCandidates()` (or the constant), `sniffImage(buffer)` (returns `"png" | "jpeg" | "webp" | null`).
- Pure helpers in `mods/projects/group.js` (ESM, no imports; tested by importing it, as the existing group tests do): `letterOf(name)`, `colorIndex(path, n)`, `stripLogin(branch, logins)`.

### Sidebar (`mods/projects`)

- After `loadSaved`, if any project has no `icon` field, run `projects resolve-icons` (at most once per sidebar start, guarded by `this.resolvedOnce`), then load the list again. Never run it during render. A project added later is resolved by the add flow calling `resolve-icons` after `projects add`.
- Headers use the saved `name` when present. `group.js` passes the name, icon, letter and colour through from `saved` the same way it passes `exists`.
- The header row is `▾ [icon 16] Name  N  [+ on hover]`.
  - Icon: `image(icon).size(16).rounded(3)`.
  - Badge: a 16×16 `rounded(3)` square in the palette colour, with the white letter in `text_size(10)` bold.
  - Palette: the theme's `ansi1…ansi6` plus their bright variants, if the theme has them. Otherwise six fixed hex colours.
- Load `projects logins` once at start. `label()` applies `stripLogin` to branch names, for live and sleeping rows alike.
- `+` hover: keep `this.hoverHeader = g.key` from `on_hover`, and draw `+` only for that key, or while the `+` itself is hovered.

### Menu and dialogs (`mods/orca-project`)

- **Header menu:** add **Rename…** and **Change icon…** above the current items, only for saved projects (`props.saved`), and grow the popup's height to fit. Unsaved repo groups keep today's "Not saved" note and show the letter badge. `rename` and `set-icon` fail for a path that isn't saved. *(Builder-check call.)*
- **Rename…:** a dialog with an `Input` prefilled with the current name. Enter saves (`projects rename`), Esc cancels. An empty name resets to the folder name.
- **Change icon…:** a small dialog with four rows: GitHub avatar, Icon from repo, Letter, and Custom… (shows an `Input` for a path or URL, plus Apply). Each runs `projects set-icon`. An error shows inline and leaves the dialog open.
- **After any change:** `setShared("orca.projects.rev", Date.now())`. The sidebar already reloads on `rev`.

## Left to the builder

- Exact dialog sizes, spacing and palette hex values.
- Whether `resolve-icons` runs per project in parallel.
- The YAML parse details for `hosts.yml`.
