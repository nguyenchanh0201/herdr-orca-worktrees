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
  MODS=(orca-setup orca-remove)
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
  mkdir -p "$dest"
  rsync -a --delete "$src/" "$dest/"
done
