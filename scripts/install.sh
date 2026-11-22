#!/usr/bin/env bash
# Install the Orca mods into Herdr.app.
#   bash scripts/install.sh            full install: npm deps, every mod, the "orca" layout, checks
#   bash scripts/install.sh projects   reinstall just these mods (no checks)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERDR_APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
NODE_BIN="$(command -v node || true)"
CLI_PATH="$REPO/bin/orca-wt.js"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node not found on PATH (install Node 20+ first)" >&2
  exit 1
fi

FULL=0
MODS=("$@")
if [[ ${#MODS[@]} -eq 0 ]]; then
  FULL=1
  MODS=(orca-setup orca-remove projects orca-agents orca-worktree orca-project orca-commits orca-usage orca-usage-panel orca-tabs orca-resources orca-resources-panel)
fi

# The orca-wt CLI needs its npm dependency (yaml).
if [[ ! -d "$REPO/node_modules/yaml" ]]; then
  echo "installing npm dependencies…"
  (cd "$REPO" && npm install --omit=dev --no-audit --no-fund >/dev/null)
fi

mkdir -p "$HERDR_APP_HOME/mods" "$HERDR_APP_HOME/layouts" "$HERDR_APP_HOME/orca-icons"

# The mods' own icons live outside any mod (svg("orca-icons/<name>.svg")), so they install first.
rsync -a --delete "$REPO/assets/icons/" "$HERDR_APP_HOME/orca-icons/"

for m in "${MODS[@]}"; do
  src="$REPO/mods/$m"
  if [[ ! -d "$src" ]]; then
    echo "unknown mod: $m" >&2
    exit 1
  fi

  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [out, node, cli] = process.argv.slice(1);
    fs.writeFileSync(out, `export default ${JSON.stringify({ node, cli })};\n`);
  ' "$src/config.js" "$NODE_BIN" "$CLI_PATH"

  # -L: a mod's `ui` is a symlink to the shared ui/ (a mod can't import outside its own folder), so copy its files.
  dest="$HERDR_APP_HOME/mods/$m"
  if [[ -L "$dest" ]]; then
    rm -f "$dest"
  fi
  if [[ -d "$dest" ]]; then
    copy_args=(-aL --delete)
    if [[ $FULL -eq 0 ]]; then
      # Older companion panels still use these paths until they are reinstalled.
      case "$m" in
        orca-usage) copy_args+=(--filter='protect /refresh.svg') ;;
        orca-resources) copy_args+=(--filter='protect /chip.svg') ;;
      esac
    fi
    rsync "${copy_args[@]}" "$src/" "$dest/"
  else
    # Herdr docks a new mod folder the moment it appears; a half-copied one
    # (main.js before mod.json) gets the default right dock. Move it in whole.
    tmp="$(mktemp -d "$HERDR_APP_HOME/.install-XXXXXX")"
    rsync -aL "$src/" "$tmp/"
    mv "$tmp" "$dest"
  fi
  echo "installed mod: $m"
done

upgrade_git_panel() {
  if [[ -d "$HERDR_APP_HOME/mods/orca-tabs" && -d "$HERDR_APP_HOME/mods/orca-commits" && -f "$HERDR_APP_HOME/layouts/orca.json" ]]; then
    "$NODE_BIN" "$REPO/scripts/enable-git-panel.js" "$HERDR_APP_HOME/layouts/orca.json" "$HERDR_APP_HOME/keys.json"
  fi
}

if [[ $FULL -eq 0 ]]; then
  upgrade_git_panel
  exit 0
fi

# The layout that places the mods. Never overwrite one the person already has.
LAYOUT="$HERDR_APP_HOME/layouts/orca.json"
NEW_LAYOUT=0
if [[ -e "$LAYOUT" ]]; then
  echo "kept your existing layouts/orca.json (repo copy: $REPO/layouts/orca.json)"
else
  cp "$REPO/layouts/orca.json" "$LAYOUT"
  NEW_LAYOUT=1
  echo "installed layout: orca"
fi

upgrade_git_panel

if command -v herdr-app >/dev/null 2>&1; then
  failed=0
  for m in "${MODS[@]}"; do
    herdr-app check "$HERDR_APP_HOME/mods/$m" >/dev/null 2>&1 || { echo "check FAILED: $m (run: herdr-app check $HERDR_APP_HOME/mods/$m)" >&2; failed=1; }
  done
  [[ $failed -eq 0 ]] && echo "all mods passed herdr-app check"
  # Only switch the running app for a fresh layout in the default home.
  if [[ $NEW_LAYOUT -eq 1 && "$HERDR_APP_HOME" == "$HOME/.config/herdr-app" ]]; then
    herdr-app do layout.switch --name orca >/dev/null 2>&1 \
      && echo "switched Herdr to the orca layout" \
      || echo "open Herdr, then press ctrl-shift-l until the orca layout shows"
  fi
  exit $failed
else
  echo "herdr-app not on PATH: skipped checks. Open Herdr and press ctrl-shift-l until the orca layout shows."
fi
