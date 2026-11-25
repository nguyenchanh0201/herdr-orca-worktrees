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
  MODS=()
  for manifest in "$REPO"/mods/*/mod.json; do
    MODS+=("$(basename "$(dirname "$manifest")")")
  done
fi

# Gitview's companions form one unit. Source comes from this repo; only
# the pinned Rust engine is downloaded, with its committed SHA-256 checked.
INSTALL_GITVIEW=0
for m in "${MODS[@]}"; do
  case "$m" in gitview|gitview-*) INSTALL_GITVIEW=1 ;; esac
done
if [[ $INSTALL_GITVIEW -eq 1 ]]; then
  if [[ $FULL -eq 0 ]]; then
    for manifest in "$REPO"/mods/gitview*/mod.json; do
      m="$(basename "$(dirname "$manifest")")"
      case " ${MODS[*]} " in *" $m "*) ;; *) MODS+=("$m") ;; esac
    done
  fi
  GITVIEW_ENGINE="$("$NODE_BIN" "$REPO/scripts/gitview-engine.js" "$HERDR_APP_HOME")"
  HERDR_BIN="${HERDR_APP_BIN:-$(command -v herdr-app || true)}"
  HC_BIN="$(command -v hc || true)"
  HERDR_BIN="${HERDR_BIN:-herdr-app}"
  HC_BIN="${HC_BIN:-hc}"
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

  case "$m" in gitview|gitview-*)
    # A complete folder is swapped once so Herdr never loads a partially
    # copied module graph, and unchanged mods don't restart their tasks.
    dest="$HERDR_APP_HOME/mods/$m"
    tmp="$(mktemp -d "$HERDR_APP_HOME/.install-XXXXXX")"
    rsync -aL "$src/" "$tmp/"
    if [[ "$m" == gitview ]]; then
      "$NODE_BIN" -e '
        const fs = require("node:fs");
        const [out, bin, herdr_app, hc] = process.argv.slice(1);
        fs.writeFileSync(out, JSON.stringify({bin, herdr_app, hc}, null, 2) + "\n");
      ' "$tmp/config.json" "$GITVIEW_ENGINE" "$HERDR_BIN" "$HC_BIN"
    fi
    if [[ -d "$dest" ]] && diff -rq -x '*.d.ts' -x jsconfig.json -x '*.before-orca' -x '.*' "$tmp" "$dest" >/dev/null 2>&1 \
      && { [[ "$m" != gitview ]] || cmp -s "$tmp/config.json" "$dest/config.json"; }; then
      rm -rf "$tmp"
    else
      if [[ -d "$dest/.cache" ]]; then cp -R "$dest/.cache" "$tmp/.cache"; fi
      if [[ -e "$dest" || -L "$dest" ]]; then mv "$dest" "$tmp.old"; fi
      mv "$tmp" "$dest"
      rm -rf "$tmp.old"
    fi
    echo "installed mod: $m"
    continue
  ;; esac

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
