const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('partial reinstall preserves legacy icons used by older companion panels', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repo = path.join(__dirname, '..');
  const checkout = path.join(root, 'checkout');
  const herdrHome = path.join(root, 'herdr');
  for (const dir of ['scripts', 'assets', 'ui']) {
    fs.cpSync(path.join(repo, dir), path.join(checkout, dir), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('yaml/package.json')), path.join(checkout, 'node_modules', 'yaml'));

  const legacyFiles = [];
  const legacyPanels = [];
  const upgrades = [
    ['orca-usage', 'refresh.svg'],
    ['orca-resources', 'chip.svg'],
  ];
  for (const [mod, icon] of upgrades) {
    fs.cpSync(path.join(repo, 'mods', mod), path.join(checkout, 'mods', mod), {
      recursive: true,
      verbatimSymlinks: true,
    });

    const installedMod = path.join(herdrHome, 'mods', mod);
    const installedPanel = path.join(herdrHome, 'mods', `${mod}-panel`);
    fs.mkdirSync(installedMod, { recursive: true });
    fs.mkdirSync(installedPanel);
    const legacyIcon = path.join(installedMod, icon);
    fs.copyFileSync(path.join(repo, 'assets', 'icons', icon), legacyIcon);
    legacyFiles.push(legacyIcon);

    const panelSource = path.join(installedPanel, 'main.js');
    const panelCode = `svg("mods/${mod}/${icon}");\n`;
    fs.writeFileSync(panelSource, panelCode);
    legacyPanels.push([panelSource, panelCode]);
  }

  const result = spawnSync('bash', ['scripts/install.sh', ...upgrades.map(([mod]) => mod)], {
    cwd: checkout,
    encoding: 'utf8',
    env: { ...process.env, HERDR_APP_HOME: herdrHome },
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  for (const [mod, icon] of upgrades) {
    assert.ok(fs.existsSync(path.join(herdrHome, 'orca-icons', icon)));
    assert.match(fs.readFileSync(path.join(herdrHome, 'mods', mod, 'main.js'), 'utf8'), /orca-icons\//);
  }
  for (const [file, source] of legacyPanels) {
    assert.equal(fs.readFileSync(file, 'utf8'), source);
  }
  for (const icon of legacyFiles) {
    assert.ok(fs.existsSync(icon), `legacy panel still needs ${icon}`);
  }
});
