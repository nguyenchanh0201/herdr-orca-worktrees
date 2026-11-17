const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Only the native GPUI/Herdr boundary is replaced; methods and grouping stay real.
function element(kind, path) {
  const node = { kind, path, attrs: {}, kids: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') target.kids.push(args[0]);
      else if (key === 'children') target.kids.push(...args[0]);
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else target.attrs[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}

async function harness(respond = () => ({}), overlayProps = null) {
  const state = { shared: new Map(), calls: [], runs: [], storageSets: [], scrolls: [], spaces: [], agents: [], checking: false, notices: 0, overlays: [], inputs: [] };
  const pending = [];
  const cx = { notify() { state.notices++; }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); }, timer: { every() {} } };
  const context = {
    ...await import('../mods/projects/group.js'),
    ...await import('../mods/projects/sleep.js'),
    ...await import('../mods/projects/sidebar.js'),
    View: class {}, div: () => element('div'), svg: p => element('svg', p), image: p => element('image', p),
    h_flex: () => element('h_flex'), v_flex: () => element('v_flex'),
    ScrollHandle: { new: () => ({ scroll_to_item(i) { state.scrolls.push(i); } }) },
    localStorage: { getItem: () => null, setItem(k, v) { state.storageSets.push([k, v]); } },
    shared: key => state.shared.get(key), setShared: (k, v) => state.shared.set(k, v),
    spaces: () => state.spaces, panes: () => [], agents: () => state.agents, machines: () => [{ name: null, layout: 'ready' }],
    checking: () => state.checking, layout: () => null, knownAgents: async () => [],
    run(cmd, args) { state.runs.push({ cmd, args }); }, openOverlay(spec) { state.overlays.push({ open: JSON.parse(JSON.stringify(spec)) }); }, closeOverlay(id) { state.overlays.push({ close: id }); },
    props: () => overlayProps, notify() {}, setAgentOrder() {}, pickFolder: async () => '/new',
    InputState: { new(options = {}) {
      const input = { options, text: options.value ?? '', handlers: {}, value() { return this.text; }, set_value(v) { this.text = v; }, on(event, fn) { this.handlers[event] = fn; }, focus() { this.focused = true; } };
      state.inputs.push(input);
      return input;
    } },
    Input: { new: input => element('Input', input) },
    theme: () => ({
      blocked: 'c-blocked', working: 'c-working', done: 'c-done', idle: 'c-idle', unknown: 'c-unknown',
      selected: 'c-selected', hover: 'c-hover', border: 'c-border', muted: 'c-muted', dim: 'c-dim',
      foreground: 'c-fg', chrome: 'c-chrome',
    }), home: () => '/home', appHome: () => '/app', readTextFile: async () => null,
    config: { node: 'node', cli: 'cli' },
    exec: async (_cmd, argv, options) => {
      const args = argv.slice(1);
      state.calls.push({ args, options });
      return { code: 0, stdout: JSON.stringify(await respond(args)), stderr: '' };
    },
  };
  const className = overlayProps ? 'OrcaProject' : 'Projects';
  const source = fs.readFileSync(require.resolve(`../mods/${overlayProps ? 'orca-project' : 'projects'}/main.js`), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(`export default class ${className}`, `class ${className}`);
  vm.runInNewContext(`${source}\nthis.Mod = ${className};`, context);
  const view = new context.Mod();
  view.init({}, cx);
  return { view, cx, state, async flush() { while (pending.length) await Promise.all(pending.splice(0)); } };
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...tree.kids.flatMap(nodes)];
}
function texts(tree) {
  return tree.kids.flatMap(c => typeof c === 'string' ? [c] : texts(c));
}

// Catches omitted initial state, login assignment, notification, or repeated loading on refresh.
test('init loads login identities once and initializes sidebar state', async () => {
  const h = await harness(args => args[1] === 'logins' ? { logins: ['jimmy'] } : { projects: [], seeded: true });
  assert.deepEqual(Array.from(h.view.logins ?? ['missing']), []);
  assert.equal(h.view.resolvedOnce, false);
  assert.equal(h.view.hoverHeader, null);
  await h.flush();
  assert.deepEqual(Array.from(h.view.logins), ['jimmy']);
  h.view.loadSaved(h.cx);
  await h.flush();
  assert.equal(h.state.calls.filter(c => c.args[1] === 'logins').length, 1);
  assert.ok(h.state.notices > 0);
});

// Catches missing resolve, wrong timeout, ignored results, and repeated startup resolve.
test('unresolved saved icons resolve once per start and again after adding a project', async () => {
  const h = await harness(args => {
    if (args[1] === 'list') return { projects: [{ path: '/old', iconSource: null }], seeded: true };
    if (args[1] === 'resolve-icons') return { projects: [{ path: '/old', iconSource: 'letter' }] };
    if (args[1] === 'add') return { path: '/new' };
    return {};
  });
  await h.flush();
  let resolves = h.state.calls.filter(c => c.args[1] === 'resolve-icons');
  assert.equal(resolves.length, 1);
  assert.equal(resolves[0].options.timeout, 60000);
  assert.equal(h.view.saved[0].iconSource, 'letter');
  h.view.loadSaved(h.cx);
  await h.flush();
  assert.equal(h.state.calls.filter(c => c.args[1] === 'resolve-icons').length, 1);
  h.state.shared.set('orca.projects.request', { id: 1, kind: 'pick' });
  h.view.check(h.cx);
  await h.flush();
  resolves = h.state.calls.filter(c => c.args[1] === 'resolve-icons');
  assert.equal(resolves.length, 2);
  assert.equal(resolves[1].options.timeout, 60000);
  assert.equal(h.view.saved[0].iconSource, 'letter');
});

// A slow or offline icon fetch must not hold back the saved list or the redraw.
test('saved projects show before resolve-icons finishes', async () => {
  let finish, answerList;
  const slow = new Promise((r) => { finish = r; });
  const list = new Promise((r) => { answerList = r; });
  const h = await harness(args => {
    if (args[1] === 'list') return list;
    if (args[1] === 'resolve-icons' || args[1] === 'logins') return slow;
    return {};
  });
  const tick = () => new Promise((r) => setImmediate(r));
  await tick();
  const before = h.state.notices;
  answerList({ projects: [{ path: '/old', iconSource: null }], seeded: true });
  await tick(); await tick();
  assert.equal(h.view.saved.length, 1);
  assert.ok(h.state.notices > before, 'redraw must not wait for resolve-icons');
  finish({ logins: [], projects: [{ path: '/old', iconSource: 'letter' }] });
  await h.flush();
  assert.equal(h.view.saved[0].iconSource, 'letter');
});

// Catches missing/reordered icons, wrong badge styling/name, or network work during render.
test('repo headers draw relative images or eight readable letter badge colors and display names', async () => {
  const h = await harness();
  await h.flush();
  const calls = h.state.calls.length;
  const g = { kind: 'repo', key: 'a', name: 'folder', displayName: 'Coduct.CTM.UserApp', rows: [], primary: '/repo', icon: 'data/project-icons/avatar.png' };
  const head = h.view.renderHeader(g, false, {});
  assert.equal(head.kids[1].kind, 'image');
  assert.equal(head.kids[1].path, 'data/project-icons/avatar.png');
  assert.equal(head.kids[1].attrs.size, 16);
  assert.equal(head.kids[1].attrs.rounded, 3);
  assert.ok('flex_none' in head.kids[1].attrs);
  assert.ok(texts(head).includes('Coduct.CTM.UserApp'));
  assert.ok(!texts(head).includes('folder'));
  const colors = ['#b45309', '#4d7c0f', '#047857', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d', '#c2410c'];
  for (const [i, key] of Array.from('abcdefgh').entries()) {
    const badge = h.view.renderHeader({ ...g, key, icon: null }, false, {}).kids[1];
    assert.equal(badge.attrs.size, 16);
    assert.equal(badge.attrs.rounded, 3);
    assert.equal(badge.attrs.bg, colors[i]);
    assert.ok('items_center' in badge.attrs && 'justify_center' in badge.attrs);
    assert.ok(nodes(badge).some(n => n.attrs.text_size === 10 && 'font_bold' in n.attrs && n.attrs.text_color === '#ffffff'));
    assert.deepEqual(texts(badge), ['U']);
  }
  assert.equal(h.state.calls.length, calls);
});

// Catches always-visible + or missing hover notifications.
test('add control appears only on the hovered repo header', async () => {
  const h = await harness();
  await h.flush();
  const g = { kind: 'repo', key: 'a', name: 'folder', displayName: 'Name', rows: [], primary: '/repo' };
  let head = h.view.renderHeader(g, false, {});
  assert.ok(!texts(head).includes('+'));
  const before = h.state.notices;
  head.attrs.on_hover(true, h.cx);
  assert.equal(h.state.notices, before + 1);
  head.attrs.on_hover(true, h.cx);
  assert.equal(h.state.notices, before + 1);
  head = h.view.renderHeader(g, false, {});
  assert.ok(texts(head).includes('+'));
  head.attrs.on_hover(false, h.cx);
  assert.ok(!texts(h.view.renderHeader(g, false, {})).includes('+'));
});

// Each rendered label path must strip a known login, not just the pure helper.
test('Projects rows and live/sleeping Activity rows use loaded login identities', async () => {
  const h = await harness(args => args[1] === 'logins' ? { logins: ['jimmy'] } : {});
  await h.flush();
  const space = { id: 's', folder: '/repo', machine: null, branch: 'jimmy/feat-comments', named: false, name: 's', active: false, tabs: [] };
  const rowTexts = texts(h.view.renderRow({ space }, {}));
  h.state.spaces = [space];
  h.state.agents = [{ address: 'agent', space: 's', status: 'idle', app: 'claude', program: null, pane: 'p' }];
  h.view.repo.set('/repo', { primary: '/repo', linked: false });
  h.view.saved = [{ path: '/repo', name: null, icon: null, exists: true }];
  h.view.sleepingByWorktree = { '/sleep': { repo: '/repo', branch: 'jimmy/explore', agents: [{ kind: 'claude', name: 'Sleeper' }] } };
  h.view.view = 'activity';
  const tree = h.view.render();
  assert.deepEqual([
    rowTexts.includes('feat-comments'),
    texts(tree).includes('feat-comments'),
    texts(tree).includes('explore'),
  ], [true, true, true]);
  assert.ok(!texts(tree).some(s => s.startsWith('jimmy/')));
});

// Catches missing display-name props/space for the expanded project popup.
test('header right-click opens expanded popup with the display name', async () => {
  const h = await harness();
  await h.flush();
  const tree = h.view.renderHeader({ kind: 'repo', key: 'r', primary: '/repo', saved: true, displayName: 'Admin Portal', rows: [] }, false, {});
  tree.attrs.on_mouse_down[1]({}, h.cx);
  assert.deepEqual(h.state.overlays, [{ open: { mod: 'orca-project', kind: 'popup', width: 220, height: 150, props: { mode: 'header', path: '/repo', saved: true, name: 'Admin Portal' } } }]);
});

// Catches actions on unsaved groups, missing/reordered rows, or incorrect dialog contracts.
test('saved header menu closes before opening rename/icon dialogs; unsaved only explains', async () => {
  for (const [label, mode, height, extra] of [['Rename…', 'rename', 160, { name: 'Admin Portal' }], ['Change icon…', 'icon', 260, {}]]) {
    const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin Portal' });
    const tree = h.view.render();
    assert.deepEqual(texts(tree), ['Rename…', 'Change icon…', 'Remove from sidebar']);
    nodes(tree).find(n => n.attrs.on_click && texts(n).includes(label)).attrs.on_click({}, h.cx);
    assert.deepEqual(h.state.overlays, [{ close: 'menu' }, { open: { mod: 'orca-project', kind: 'dialog', width: 420, height, props: { mode, path: '/repo', ...extra } } }]);
  }
  const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: false, path: '/repo' });
  assert.deepEqual(texts(h.view.render()), ['Not saved — it shows while its spaces are open']);
  assert.equal(nodes(h.view.render()).filter(n => n.attrs.on_click).length, 0);
});

// Catches lost prefill/retention, missing submit binding, empty-name rejection, or absent refresh/close.
test('rename dialog retains prefilled input and submits Enter or Save including empty names', async () => {
  for (const [value, enter] of [['Admin Portal', true], ['', false]]) {
    const h = await harness(undefined, { overlay: 'rename', mode: 'rename', path: '/repo', name: 'Old name' });
    let tree = h.view.render();
    assert.ok(texts(tree).includes('Rename project'));
    assert.ok(texts(tree).includes('Leave empty to use the folder name'));
    const input = nodes(tree).find(n => n.kind === 'Input')?.path;
    assert.equal(input?.value(), 'Old name');
    assert.equal(input.focused, true);
    input.set_value(value);
    tree = h.view.render();
    assert.equal(nodes(tree).find(n => n.kind === 'Input').path, input);
    if (enter) input.handlers.submit({}, h.cx);
    else nodes(tree).find(n => n.attrs.on_click && texts(n).includes('Save')).attrs.on_click({}, h.cx);
    await h.flush();
    assert.deepEqual(Array.from(h.state.calls[0].args), ['projects', 'rename', '/repo', value]);
    assert.equal(typeof h.state.shared.get('orca.projects.rev'), 'number');
    assert.deepEqual(h.state.overlays, [{ close: 'rename' }]);
  }
});

// Catches closing/refreshing on CLI errors or missing Escape handling from the input focus path.
test('rename errors stay inline in blocked color and Escape closes', async () => {
  const h = await harness(() => ({ error: 'Rename failed' }), { overlay: 'rename', mode: 'rename', path: '/repo', name: 'Old' });
  const tree = h.view.render();
  assert.ok(texts(tree).includes('Save'));
  nodes(tree).find(n => n.attrs.on_click && texts(n).includes('Save')).attrs.on_click({}, h.cx);
  await h.flush();
  const failed = h.view.renderRename({ blocked: 'error-color' });
  assert.ok(nodes(failed).some(n => n.attrs.text_color === 'error-color' && texts(n).includes('Rename failed')));
  assert.deepEqual(h.state.overlays, []);
  assert.equal(h.state.shared.has('orca.projects.rev'), false);
  failed.attrs.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.state.overlays, [{ close: 'rename' }]);
});

// Catches wrong CLI sources/timeout, missing retained custom input, or missing success refresh.
test('icon dialog applies all sources and custom input through Apply or Enter', async () => {
  for (const [label, source, value, enter] of [['GitHub avatar', 'github'], ['Icon from repo', 'repo'], ['Letter', 'letter'], ['Apply', 'custom', '/tmp/icon.png'], ['Apply', 'custom', 'https://example.com/icon.webp', true]]) {
    const h = await harness(undefined, { overlay: 'icon', mode: 'icon', path: '/repo' });
    const tree = h.view.render();
    assert.deepEqual(texts(tree), ['Project icon', 'GitHub avatar', 'Icon from repo', 'Letter', 'Custom…', 'Apply']);
    const input = nodes(tree).find(n => n.kind === 'Input')?.path;
    assert.equal(input?.options.placeholder, 'Path or URL to a PNG, JPEG or WebP, up to 256 KB');
    if (value) input.set_value(value);
    assert.equal(nodes(h.view.render()).find(n => n.kind === 'Input').path, input);
    if (enter) input.handlers.submit({}, h.cx);
    else nodes(tree).find(n => n.attrs.on_click && texts(n).includes(label)).attrs.on_click({}, h.cx);
    await h.flush();
    assert.deepEqual(Array.from(h.state.calls[0].args), ['projects', 'set-icon', '/repo', source, ...(value ? [value] : [])]);
    assert.equal(h.state.calls[0].options.timeout, 30000);
    assert.equal(typeof h.state.shared.get('orca.projects.rev'), 'number');
    assert.deepEqual(h.state.overlays, [{ close: 'icon' }]);
  }
});

// Catches absent synchronous busy guard, Working text, inline errors, or permanent busy state after failure.
test('icon dialog shows Working and ignores further clicks until error allows retry', async () => {
  let finish;
  const h = await harness(() => new Promise(resolve => { finish = resolve; }), { overlay: 'icon', mode: 'icon', path: '/repo' });
  const tree = h.view.render();
  assert.ok(texts(tree).includes('GitHub avatar'));
  const click = label => nodes(tree).find(n => n.attrs.on_click && texts(n).includes(label)).attrs.on_click({}, h.cx);
  click('GitHub avatar');
  click('Letter');
  click('Apply');
  assert.ok(texts(h.view.render()).includes('Working…'));
  await Promise.resolve();
  assert.equal(h.state.calls.length, 1);
  finish({ error: 'Bad icon path' });
  await h.flush();
  const failed = h.view.renderIcon({ blocked: 'error-color' });
  assert.ok(nodes(failed).some(n => n.attrs.text_color === 'error-color' && texts(n).includes('Bad icon path')));
  assert.ok(!texts(failed).includes('Working…'));
  assert.deepEqual(h.state.overlays, []);
  assert.equal(h.state.shared.has('orca.projects.rev'), false);
  nodes(failed).find(n => n.attrs.on_click && texts(n).includes('Letter')).attrs.on_click({}, h.cx);
  await Promise.resolve();
  assert.equal(h.state.calls.length, 2);
  finish({});
  await h.flush();
  assert.deepEqual(h.state.overlays, [{ close: 'icon' }]);
});

test('icon dialog Escape closes without changing the project', async () => {
  const h = await harness(undefined, { overlay: 'icon', mode: 'icon', path: '/repo' });
  const tree = h.view.render();
  assert.ok(texts(tree).includes('Project icon'));
  tree.attrs.on_key_down({ key: 'escape' }, h.cx);
  assert.deepEqual(h.state.overlays, [{ close: 'icon' }]);
  assert.equal(h.state.calls.length, 0);
});

async function cardHarness() {
  const h = await harness();
  await h.flush();
  const space = { id: 's1', folder: '/r', machine: null, branch: 'main', named: false, name: 's1', active: true, tabs: [] };
  h.state.spaces = [space];
  h.state.agents = [
    { address: 'a1', space: 's1', pane: 'p1', status: 'done', program: { name: 'Claude', icon: 'icons/claude.svg' } },
    { address: 'a2', space: 's1', pane: 'p2', status: 'blocked', program: { name: 'Codex', icon: 'icons/codex.svg' } },
  ];
  h.view.repo.set('/r', { primary: '/r', linked: false });
  h.view.saved = [{ path: '/r', name: null, icon: null, exists: true }];
  return h;
}

test('worktree card folds agents into a strip by default', async () => {
  const h = await cardHarness();
  const tree = h.view.render();
  const t = texts(tree);
  assert.ok(t.includes('!'));
  assert.ok(t.includes('›'));
  assert.ok(!t.includes('Done - Claude'));
  const strip = nodes(tree).find((n) => n.attrs.id === 'strip-s1');
  assert.ok(strip);
  const glyph = strip.kids.find((n) => texts(n).includes('!'));
  assert.equal(glyph?.attrs.text_color, 'c-blocked');
  const icons = nodes(strip).filter((n) => n.kind === 'image' || n.kind === 'svg');
  assert.equal(icons.length, 2);
});

test('clicking the strip unfolds and remembers it', async () => {
  const h = await cardHarness();
  let tree = h.view.render();
  const strip = nodes(tree).find((n) => n.attrs.id === 'strip-s1');
  strip.attrs.on_click({}, h.cx);
  assert.equal(h.view.agentsOpen.has('/r'), true);
  assert.deepEqual(h.state.storageSets.at(-1), ['projects.agentsOpen', JSON.stringify(['/r'])]);

  tree = h.view.render();
  const t = texts(tree);
  assert.ok(t.includes('2 agents'));
  assert.ok(t.includes('Blocked - Codex'));
  assert.ok(t.includes('Done - Claude'));

  const head = nodes(tree).find((n) => n.attrs.id === 'agents-head-s1');
  head.attrs.on_click({}, h.cx);
  assert.equal(h.view.agentsOpen.has('/r'), false);
  assert.deepEqual(h.state.storageSets.at(-1), ['projects.agentsOpen', JSON.stringify([])]);
});

test('agent row click focuses its pane', async () => {
  const h = await cardHarness();
  h.view.agentsOpen.add('/r');
  const tree = h.view.render();
  const row = nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Done - Claude'));
  assert.ok(row);
  row.attrs.on_click({}, h.cx);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.runs)), [{ cmd: 'pane.focus', args: { pane: 'p1' } }]);
});

test('main checkout shows the main badge instead of a star', async () => {
  const h = await cardHarness();
  const t = texts(h.view.render());
  assert.ok(t.includes('main'));
  assert.ok(!t.includes('★'));
});

test('card without agents has no strip', async () => {
  const h = await cardHarness();
  h.state.agents = [];
  const t = texts(h.view.render());
  assert.ok(!t.includes('›'));
  assert.ok(!t.some((s) => s.includes('agent')));
});

test('sleeping worktree card shows a dimmed strip with a moon', async () => {
  const h = await harness();
  await h.flush();
  h.view.saved = [{ path: '/r', name: null, icon: null, exists: true }];
  h.view.sleepingByWorktree = {
    '/wt/s': { version: 1, sleptAt: 1000, repo: '/r', branch: 'feat/s', agents: [{ kind: 'claude', name: 'Claude' }] },
  };
  const tree = h.view.render();
  const strip = nodes(tree).find((n) => n.attrs.id === 'strip-/wt/s');
  assert.ok(strip);
  assert.ok(nodes(strip).some((n) => n.kind === 'svg' && n.path === 'mods/projects/moon.svg'));
  const title = nodes(tree).find((n) => n.attrs.id === 'sleep-/wt/s');
  assert.ok(title);
  title.attrs.on_click({}, h.cx);
  const req = h.state.shared.get('orca.projects.request');
  assert.equal(req.kind, 'wake');
  assert.equal(req.worktree, '/wt/s');
});

test('scroll_to_item targets the active card index after a fold toggle', async () => {
  const h = await cardHarness();
  h.state.spaces = [
    { id: 's1', folder: '/r', machine: null, branch: 'main', named: false, name: 's1', active: true, tabs: [] },
    { id: 's2', folder: '/wt/2', machine: null, branch: 'feat/2', named: false, name: 's2', active: false, tabs: [] },
  ];
  h.view.repo.set('/wt/2', { primary: '/r', linked: true });
  h.view.render();
  assert.equal(h.state.scrolls.at(-1), 1);

  h.view.toggleAgents('/r', h.cx);
  h.state.spaces[0].active = false;
  h.state.spaces[1].active = true;
  h.view.render();
  assert.equal(h.state.scrolls.at(-1), 2);
});

test('card with >5 agents caps strip icons at 5 and shows +N', async () => {
  const h = await cardHarness();
  h.state.agents = Array.from({ length: 7 }, (_, i) => ({
    address: `a${i}`, space: 's1', pane: `p${i}`, status: 'idle', program: { name: 'Claude', icon: 'icons/claude.svg' },
  }));
  const strip = nodes(h.view.render()).find((n) => n.attrs.id === 'strip-s1');
  const icons = nodes(strip).filter((n) => n.kind === 'image' || n.kind === 'svg');
  assert.equal(icons.length, 5);
  assert.ok(texts(strip).includes('+2'));
});

test('unknown or missing agent status falls back to idle glyph in unknown color', async () => {
  const h = await cardHarness();
  h.state.agents = [
    { address: 'a1', space: 's1', pane: 'p1', status: 'weird', program: { name: 'Claude', icon: 'icons/claude.svg' } },
    { address: 'a2', space: 's1', pane: 'p2', program: { name: 'Codex', icon: 'icons/codex.svg' } },
  ];
  let tree = h.view.render();
  const strip = nodes(tree).find((n) => n.attrs.id === 'strip-s1');
  const stripGlyph = strip.kids.find((n) => texts(n).includes('○'));
  assert.equal(stripGlyph?.attrs.text_color, 'c-unknown');

  h.view.agentsOpen.add('/r');
  tree = h.view.render();
  assert.ok(texts(tree).includes('Weird - Claude'));
  assert.ok(texts(tree).includes('Unknown - Codex'));
});

test('remote space renders machine chip, toggles with empty folder, and isolates shared folder ids', async () => {
  const h = await harness();
  await h.flush();
  h.state.spaces = [
    { id: 'r1', folder: '', machine: 'vps', branch: 'main', named: false, name: 'r1', active: false, tabs: [] },
    { id: 'r2', folder: '', machine: 'vps', branch: 'dev', named: false, name: 'r2', active: false, tabs: [] },
  ];
  h.state.agents = [
    { address: 'a1', space: 'r1', pane: 'p1', status: 'working', program: { name: 'Claude', icon: 'icons/claude.svg' } },
    { address: 'a2', space: 'r2', pane: 'p2', status: 'done', program: { name: 'Codex', icon: 'icons/codex.svg' } },
  ];
  let tree = h.view.render();
  assert.ok(texts(tree).includes('vps'));
  const strip1 = nodes(tree).find((n) => n.attrs.id === 'strip-r1');
  const strip2 = nodes(tree).find((n) => n.attrs.id === 'strip-r2');
  assert.ok(strip1 && strip2);
  strip1.attrs.on_click({}, h.cx);
  tree = h.view.render();
  assert.ok(texts(tree).includes('Working - Claude'));
  assert.ok(!texts(tree).includes('Done - Codex'));
});

test('active card paints selected background once on card and not on inner title row', async () => {
  const h = await cardHarness();
  const tree = h.view.render();
  const card = nodes(tree).find((n) => n.attrs.id === 'card-s1');
  const title = nodes(tree).find((n) => n.attrs.id === 'space-s1');
  assert.equal(card?.attrs.bg, 'c-selected');
  assert.equal(title?.attrs.bg, undefined);
});

test('worktree cards are indented and borderless', async () => {
  const h = await cardHarness();
  const card = nodes(h.view.render()).find((n) => n.attrs.id === 'card-s1');
  assert.ok(card.attrs.ml > 0);
  assert.equal(card.attrs.border, undefined);
});

test('status-less worktree shows the dim dot in a fixed slot', async () => {
  const h = await cardHarness();
  const title = nodes(h.view.render()).find((n) => n.attrs.id === 'space-s1');
  const slot = title.kids.find((n) => texts(n).includes('●'));
  assert.ok(slot, 'dim dot');
  assert.ok(slot.attrs.w > 0);
  assert.ok(!texts(title).includes('·'));
});

test('agent strip has no background until hover', async () => {
  const h = await cardHarness();
  const strip = nodes(h.view.render()).find((n) => n.attrs.id === 'strip-s1');
  assert.equal(strip.attrs.bg, undefined);
  assert.ok(strip.attrs.hover);
});
