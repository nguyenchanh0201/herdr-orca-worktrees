#!/usr/bin/env bash
# Build or select orca-wt (Rust) and point the installed Herdr mods at it.
#
# The JS mods call exec(config.node, [config.cli, ...args]). This writes config.js as
# { node: <orca-wt binary>, cli: "--" }; orca-wt drops a leading "--", so the mods run unchanged.
# Go back to the Node CLI with scripts/install.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERDR_APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

if [[ $# -gt 1 ]]; then
  echo "Usage: bash scripts/install-rust.sh [path-to-prebuilt-orca-wt]" >&2
  exit 1
fi

if [[ $# -eq 1 ]]; then
  BIN="$1"
  [[ "$BIN" = /* ]] || BIN="$PWD/$BIN"
else
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
  cargo build --release --locked --manifest-path "$REPO/rust/Cargo.toml"
  BIN="$REPO/rust/target/release/orca-wt"
fi

[[ -f "$BIN" && -x "$BIN" ]] || { echo "orca-wt is not an executable file: $BIN" >&2; exit 1; }
config=$(node -p 'JSON.stringify({ node: process.argv[1], cli: "--" })' "$BIN")

shopt -s nullglob
for cfg in "$HERDR_APP_HOME"/mods/*/config.js; do
  mod=$(basename "$(dirname "$cfg")")
  if ! grep -q 'orca-wt' "$cfg"; then
    [[ -f "$REPO/mods/$mod/mod.json" ]] || continue
    grep -Fq '"cli":"--"' "$cfg" || continue
  fi
  printf 'export default %s;\n' "$config" > "$cfg"
  echo "configured $mod"
done
