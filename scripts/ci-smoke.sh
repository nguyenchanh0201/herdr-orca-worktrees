#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
archive="${1:?Usage: bash scripts/ci-smoke.sh /absolute/path/to/release.tar.gz}"
command -v herdr-app >/dev/null

smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/orca-wt-smoke.XXXXXX")
trap 'rm -rf "$smoke_dir"' EXIT
export HERDR_APP_HOME="$smoke_dir/herdr"
export ORCA_WT_STATE_DIR="$smoke_dir/state"

bash scripts/install.sh
cmp layouts/orca.json "$HERDR_APP_HOME/layouts/orca.json"

cp layouts/orca.json "$smoke_dir/expected-layout.json"
printf '\n' >> "$smoke_dir/expected-layout.json"
cp "$smoke_dir/expected-layout.json" "$HERDR_APP_HOME/layouts/orca.json"
bash scripts/install.sh
cmp "$smoke_dir/expected-layout.json" "$HERDR_APP_HOME/layouts/orca.json"

check_rust_configs() {
  node - "$1" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installDir = path.join(process.env.HERDR_APP_HOME, 'mods');
const expectedMods = fs.readdirSync('mods')
  .filter(name => fs.existsSync(path.join('mods', name, 'mod.json')));
assert.deepEqual(fs.readdirSync(installDir).sort(), expectedMods.sort());

for (const name of expectedMods) {
  if (name === 'gitview' || name.startsWith('gitview-')) {
    assert.ok(!fs.existsSync(path.join(installDir, name, 'config.js')), `${name} keeps its own engine config`);
    continue;
  }
  const file = path.join(installDir, name, 'config.js');
  const config = fs.readFileSync(file, 'utf8').trim();
  const match = /^export default (.+);$/.exec(config);
  assert.ok(match, `Invalid config: ${file}`);
  const { node, cli } = JSON.parse(match[1]);
  assert.equal(node, process.argv[2], `${name} Rust binary path`);
  assert.equal(cli, '--', `${name} Rust argument separator`);

  const result = spawnSync(node, [cli, 'sleep', 'get'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sleeping: false });
}
NODE
}

bash scripts/install-rust.sh
check_rust_configs "$PWD/rust/target/release/orca-wt"

extract_dir="$smoke_dir/prebuilt assets"
mkdir "$extract_dir"
tar -xzf "$archive" -C "$extract_dir"
bash scripts/install-rust.sh "$extract_dir/orca-wt"
check_rust_configs "$extract_dir/orca-wt"
for mod in "$HERDR_APP_HOME"/mods/*; do
  herdr-app check "$mod"
done
cmp "$smoke_dir/expected-layout.json" "$HERDR_APP_HOME/layouts/orca.json"

echo "Both Rust install paths passed. The existing layout was preserved."
