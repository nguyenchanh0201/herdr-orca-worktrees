const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Rust installer rejects an executable that returns no JSON and preserves the mod config', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-rust-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const herdrHome = path.join(root, 'herdr');
  const modsDir = path.join(herdrHome, 'mods', 'projects');
  const configPath = path.join(modsDir, 'config.js');
  const originalConfig = 'export default {"node":"/usr/bin/node","cli":"/repo/bin/orca-wt.js"};\n';
  fs.mkdirSync(modsDir, { recursive: true });
  fs.writeFileSync(configPath, originalConfig);

  const wrongBinary = path.join(root, 'wrong-binary');
  fs.writeFileSync(wrongBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const installer = path.join(__dirname, '..', 'scripts', 'install-rust.sh');
  const result = spawnSync('bash', [installer, wrongBinary], {
    encoding: 'utf8',
    env: { ...process.env, HERDR_APP_HOME: herdrHome }
  });

  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /orca-wt failed the JSON probe/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
});
