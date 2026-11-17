#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERDR_APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
NODE_BIN="$(command -v node)"
CLI_PATH="$REPO/bin/orca-wt.js"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node not found on PATH" >&2
  exit 1
fi

MODS=("$@")
if [[ ${#MODS[@]} -eq 0 ]]; then
  MODS=(orca-setup orca-remove projects orca-new orca-project orca-usage orca-usage-panel)
fi

mkdir -p "$HERDR_APP_HOME/mods"

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

  dest="$HERDR_APP_HOME/mods/$m"
  if [[ -L "$dest" ]]; then
    rm -f "$dest"
  fi
  if [[ -d "$dest" ]]; then
    rsync -a --delete "$src/" "$dest/"
  else
    # Herdr docks a new mod folder the moment it appears; a half-copied one
    # (main.js before mod.json) gets the default right dock. Move it in whole.
    tmp="$(mktemp -d "$HERDR_APP_HOME/.install-XXXXXX")"
    rsync -a "$src/" "$tmp/"
    mv "$tmp" "$dest"
  fi
done
