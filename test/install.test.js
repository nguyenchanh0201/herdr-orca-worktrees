const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('standard install includes local gitview sources and preserves them on reinstall', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-gitview-install-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(__dirname, '..');
  const appHome = path.join(root, 'herdr');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  for (const name of ['herdr-app', 'hc', 'herdr-gitview']) {
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  }
  const env = {...process.env, HERDR_APP_HOME: appHome,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    HERDR_APP_BIN: path.join(binDir, 'herdr-app'),
    GITVIEW_BIN: path.join(binDir, 'herdr-gitview')};
  function install(args = []) {
    const result = spawnSync('bash', ['scripts/install.sh', ...args], {cwd: repo, env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  install();
  const expected = fs.readdirSync(path.join(repo, 'mods')).filter(name => fs.existsSync(path.join(repo, 'mods', name, 'mod.json')));
  assert.deepEqual(fs.readdirSync(path.join(appHome, 'mods')).sort(), expected.sort());
  for (const name of expected.filter(n => n === 'gitview' || n.startsWith('gitview-'))) {
    for (const file of fs.readdirSync(path.join(repo, 'mods', name)).filter(n => n.endsWith('.js'))) {
      assert.equal(fs.readFileSync(path.join(appHome, 'mods', name, file), 'utf8'), fs.readFileSync(path.join(repo, 'mods', name, file), 'utf8'));
    }
    assert.equal(fs.existsSync(path.join(appHome, 'mods', name, 'config.js')), false);
  }
  const engineConfig = JSON.parse(fs.readFileSync(path.join(appHome, 'mods/gitview/config.json'), 'utf8'));
  assert.equal(engineConfig.bin, env.GITVIEW_BIN);
  const keys = JSON.parse(fs.readFileSync(path.join(appHome, 'keys.json'), 'utf8'));
  assert.equal(keys['layout:orca']['cmd-shift-g'], 'mod.open:gitview-sidebar');
  assert.equal(keys['layout:orca']['cmd-g'], 'mod.open:gitview-tab');
  const layoutFile = path.join(appHome, 'layouts/orca.json');
  assert.equal(fs.readFileSync(layoutFile, 'utf8'), fs.readFileSync(path.join(repo, 'layouts/orca.json'), 'utf8'));
  const original = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  original.customPreference = 'keep me';
  fs.writeFileSync(layoutFile, JSON.stringify(original));
  const main = path.join(appHome, 'mods/gitview/main.js');
  const inode = fs.statSync(main).ino;
  install(['gitview']);
  assert.equal(fs.statSync(main).ino, inode, 'unchanged gitview source is not reloaded');
  assert.equal(JSON.parse(fs.readFileSync(layoutFile, 'utf8')).customPreference, 'keep me');
});

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
