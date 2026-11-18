#!/usr/bin/env bash
# Builds orca-wt (Rust) and points the installed Herdr mods at it.
#
# The JS mods call exec(config.node, [config.cli, ...args]). This writes config.js as
# { node: <orca-wt binary>, cli: "--" }; orca-wt drops a leading "--", so the mods run unchanged.
# Go back to the Node CLI with scripts/install.sh.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HERDR_APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"

cargo build --release --manifest-path "$REPO/rust/Cargo.toml"
BIN="$REPO/rust/target/release/orca-wt"
[[ -x "$BIN" ]] || { echo "build produced no $BIN" >&2; exit 1; }

shopt -s nullglob
for cfg in "$HERDR_APP_HOME"/mods/*/config.js; do
  grep -q 'orca-wt' "$cfg" || continue
  printf 'export default {"node":"%s","cli":"--"};\n' "$BIN" > "$cfg"
  echo "configured $(basename "$(dirname "$cfg")")"
done
