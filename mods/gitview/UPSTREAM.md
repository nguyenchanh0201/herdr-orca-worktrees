# Gitview source

The `mods/gitview` and `mods/gitview-*` folders are vendored from
[ChmaraX/herdr-gitview v0.6.0](https://github.com/ChmaraX/herdr-gitview/releases/tag/v0.6.0).
Each folder retains the upstream MIT license.

Our changes are source edits: section headers always show their stage/unstage
buttons, working-change headers participate in Vim navigation and show a selection
highlight, and Enter on a header stages or unstages the section. Discard remains
available on hover. These changes live in `listview.js`, `filelist.js`, and `main.js`.

`bash scripts/install.sh` installs these local sources. It generates the installed
`gitview/config.json` and fetches only the native engine, pinned by version and
archive checksums in `scripts/gitview-release.json`. No upstream installer or
source patch runs during installation. `GITVIEW_BIN` can select an existing engine.

When upgrading upstream, review these source customizations and update the engine
version/checksums together. Shared upstream files are copied into each companion
mod because Herdr isolates mod imports.
