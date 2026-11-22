const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { readModSource } = require('./helpers/modsource');

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

async function harness(respond = () => ({}), overlayProps = null, stored = {}) {
  const state = { shared: new Map(), calls: [], runs: [], storageSets: [], scrolls: [], spaces: [], agents: [], checking: false, notices: 0, notifications: [], overlays: [], inputs: [] };
  const pending = [];
  const commandTasks = new Set();
  let currentTask, deliverCommand;
  state.focused = false;
  const cx = { notify() { state.notices++; }, stop_propagation() {}, focus_handle: () => ({ focus() { state.focused = true; }, is_focused: () => state.focused }), spawn(fn) {
    let task;
    task = Promise.resolve().then(() => { currentTask = task; try { return fn(cx); } finally { currentTask = null; } });
    pending.push(task);
  }, timer: { every() {} } };
  const context = {
    ...await import('../mods/projects/group.js'),
    ...await import('../mods/projects/sleep.js'),
    ...await import('../mods/projects/sidebar.js'),
    View: class {}, div: () => element('div'), svg: p => element('svg', p), image: p => element('image', p),
    h_flex: () => element('h_flex'), v_flex: () => element('v_flex'),
    ScrollHandle: { new: () => {
      if (state.rendering) throw new Error('ScrollHandle.new cannot run during render');
      return { scroll_to_item(i) { state.scrolls.push(i); } };
    } },
    localStorage: { getItem: key => stored[key] ?? null, setItem(k, v) { state.storageSets.push([k, v]); } },
    shared: key => state.shared.get(key), setShared: (k, v) => state.shared.set(k, v),
    spaces: () => state.spaces, panes: () => [], agents: () => state.agents, machines: () => [{ name: null, layout: 'ready' }],
    nextCommand: () => { commandTasks.add(currentTask); return new Promise(resolve => { deliverCommand = resolve; }); },
    checking: () => state.checking, layout: () => state.layout ?? null, knownAgents: async () => [],
    run(cmd, args) { state.runs.push({ cmd, args }); }, openOverlay(spec) { state.overlays.push({ open: JSON.parse(JSON.stringify(spec)) }); }, closeOverlay(id) { state.overlays.push({ close: id }); },
    props: () => overlayProps, notify(n) { state.notifications.push(n); }, setAgentOrder() {}, pickFolder: async () => '/new',
    InputState: { new(options = {}) {
      const input = { options, text: options.value ?? '', handlers: {}, value() { return this.text; }, set_value(v) { this.text = v; }, on(event, fn) { this.handlers[event] = fn; }, focus() { this.focused = true; } };
      state.inputs.push(input);
      return input;
    } },
    Input: { new: input => element('Input', input) },
    theme: () => ({
      blocked: 'c-blocked', working: 'c-working', done: 'c-done', idle: 'c-idle', unknown: 'c-unknown',
      accent: 'c-accent', selected: 'c-selected', hover: 'c-hover', border: 'c-border', muted: 'c-muted', dim: 'c-dim',
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
  const source = readModSource(overlayProps ? 'orca-project' : 'projects');
  vm.runInNewContext(`${source}\nthis.Mod = ${className};`, context);
  const view = new context.Mod();
  view.init({}, cx);
  const render = view.render.bind(view);
  view.render = (...args) => {
    state.rendering = true;
    try { return render(...args); } finally { state.rendering = false; }
  };
  return { view, cx, state,
    async command(value) { deliverCommand(value); await new Promise(setImmediate); },
    async flush() {
      await Promise.resolve();
      while (pending.length) { await Promise.all(pending.splice(0).filter(task => !commandTasks.has(task))); await Promise.resolve(); }
    },
  };
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
  assert.deepEqual(h.state.overlays, [{ open: { mod: 'orca-project', kind: 'popup', width: 220, height: 240, props: { mode: 'header', path: '/repo', saved: true, name: 'Admin Portal', group: null, groups: [] } } }]);
});

// Catches actions on unsaved groups, missing/reordered rows, or incorrect dialog contracts.
test('saved header menu closes before opening rename/icon dialogs; unsaved only explains', async () => {
  for (const [label, mode, height, extra] of [['Rename…', 'rename', 160, { name: 'Admin Portal' }], ['Change icon…', 'icon', 260, {}]]) {
    const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin Portal' });
    const tree = h.view.render();
    assert.deepEqual(texts(tree), ['Open in', '›', 'Project Group', '›', 'Rename…', 'Change icon…', 'Remove from sidebar']);
    nodes(tree).find(n => n.attrs.on_click && texts(n).includes(label)).attrs.on_click({}, h.cx);
    assert.deepEqual(h.state.overlays, [{ close: 'menu' }, { open: { mod: 'orca-project', kind: 'dialog', width: 420, height, props: { mode, path: '/repo', ...extra } } }]);
  }
  const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: false, path: '/repo' });
  assert.deepEqual(texts(h.view.render()), ['Open in', '›', 'Project Group', '›', 'Not saved — it shows while its spaces are open']);
  assert.equal(nodes(h.view.render()).filter(n => n.attrs.on_click).length, 2);
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
  h.view.toggleAgents('/r', h.cx);
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
  assert.ok(nodes(strip).some((n) => n.kind === 'svg' && n.path === 'orca-icons/moon.svg'));
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

  h.view.toggleAgents('/r', h.cx);
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

async function groupHarness() {
  const h = await harness();
  await h.flush();
  h.state.spaces = [
    { id: 's1', folder: '/r', machine: null, branch: 'main', named: false, name: 's1', active: true, tabs: [] },
    { id: 's2', folder: '/wt/2', machine: null, branch: 'feat/2', named: false, name: 's2', active: false, tabs: [] },
  ];
  h.view.repo.set('/r', { primary: '/r', linked: false });
  h.view.repo.set('/wt/2', { primary: '/r', linked: true });
  h.view.saved = [{ path: '/r', name: 'Server', icon: null, exists: true, group: 'CTM group' }];
  return h;
}

test('grouped projects render under a group header', async () => {
  const h = await groupHarness();
  const tree = h.view.render();
  const t = texts(tree);
  assert.ok(t.indexOf('CTM group') !== -1);
  assert.ok(t.indexOf('CTM group') < t.indexOf('Server'));
  assert.ok(nodes(tree).some((n) => n.attrs.id === 'group-head-group:ctm group'));
});

test('folding a group hides its projects but keeps the active card', async () => {
  const h = await groupHarness();
  let tree = h.view.render();
  const head = nodes(tree).find((n) => n.attrs.id === 'group-head-group:ctm group');
  assert.ok(head);
  head.attrs.on_click({}, h.cx);
  const lastSet = h.state.storageSets.findLast(([k]) => k === 'projects.collapsed');
  assert.ok(lastSet && JSON.parse(lastSet[1]).includes('group:ctm group'));

  tree = h.view.render();
  assert.ok(texts(tree).includes('Server'));
  assert.ok(nodes(tree).some((n) => n.attrs.id === 'card-s1'));
  assert.ok(!nodes(tree).some((n) => n.attrs.id === 'card-s2'));
});

test('folded group with no active space shows only its header', async () => {
  const h = await groupHarness();
  h.state.spaces[0].active = false;
  h.view.collapsed.add('group:ctm group');
  const tree = h.view.render();
  assert.ok(texts(tree).includes('CTM group'));
  assert.ok(!texts(tree).includes('Server'));
  assert.ok(!nodes(tree).some((n) => n.attrs.id === 'card-s1'));
});

test('ungrouped projects render as before', async () => {
  const h = await cardHarness();
  const tree = h.view.render();
  assert.ok(!nodes(tree).some((n) => typeof n.attrs.id === 'string' && n.attrs.id.startsWith('group-head-')));
});

test('header and space menus show Open in ›', async () => {
  for (const props of [
    { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin' },
    { overlay: 'menu', mode: 'space', space: 's1', worktree: '/wt', folder: '/wt', sleeping: false, hasAgents: false },
  ]) {
    const h = await harness(undefined, props);
    const t = texts(h.view.render());
    assert.ok(t.includes('Open in'));
    assert.ok(t.includes('›'));
  }
});

test('open-in lists chosen apps then Customize apps…', async () => {
  const h = await harness(
    (args) => args[0] === 'apps' && args[1] === 'list'
      ? { installed: [{ id: 'vscode', name: 'VS Code' }, { id: 'zed', name: 'Zed' }, { id: 'finder', name: 'Finder' }], chosen: ['zed', 'finder'] }
      : {},
    { overlay: 'sub', mode: 'open-in', folder: '/r', parent: 'menu' }
  );
  await h.flush();
  const t = texts(h.view.render());
  assert.deepEqual(t, ['Zed', 'Finder', 'Customize apps…']);
  assert.ok(!t.includes('VS Code'));
});

test('clicking an app opens the folder and closes both popups', async () => {
  const h = await harness(
    (args) => args[0] === 'apps' && args[1] === 'list'
      ? { installed: [{ id: 'zed', name: 'Zed' }, { id: 'finder', name: 'Finder' }], chosen: ['zed', 'finder'] }
      : { ok: true },
    { overlay: 'sub', mode: 'open-in', folder: '/r', parent: 'menu' }
  );
  await h.flush();
  const tree = h.view.render();
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Zed')).attrs.on_click({}, h.cx);
  await h.flush();
  assert.deepEqual(Array.from(h.state.calls.at(-1).args), ['open', 'zed', '/r']);
  assert.deepEqual(h.state.overlays, [{ close: 'sub' }, { close: 'menu' }]);
});

test('open failure notifies', async () => {
  const h = await harness(
    (args) => {
      if (args[0] === 'apps' && args[1] === 'list') {
        return { installed: [{ id: 'zed', name: 'Zed' }], chosen: ['zed'] };
      }
      if (args[0] === 'open') return { error: 'boom' };
      return {};
    },
    { overlay: 'sub', mode: 'open-in', folder: '/r', parent: 'menu' }
  );
  await h.flush();
  const tree = h.view.render();
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Zed')).attrs.on_click({}, h.cx);
  await h.flush();
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].level, 'error');
  assert.equal(h.state.notifications[0].body, 'boom');
});

test('Customize apps saves the checked ids', async () => {
  const h = await harness(
    (args) => args[0] === 'apps' && args[1] === 'list'
      ? { installed: [{ id: 'zed', name: 'Zed' }, { id: 'finder', name: 'Finder' }], chosen: ['zed', 'finder'] }
      : { ok: true },
    { overlay: 'dlg', mode: 'apps' }
  );
  await h.flush();
  let tree = h.view.render();
  nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Zed')).attrs.on_click({}, h.cx);
  tree = h.view.render();
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Save')).attrs.on_click({}, h.cx);
  await h.flush();
  assert.deepEqual(Array.from(h.state.calls.at(-1).args), ['apps', 'set', 'finder']);
  assert.deepEqual(h.state.overlays, [{ close: 'dlg' }]);
});

test('header menu shows Project Group ›', async () => {
  const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin' });
  const t = texts(h.view.render());
  assert.ok(t.includes('Project Group'));
});

test('group popup lists actions and other groups', async () => {
  const h = await harness(undefined, {
    overlay: 'sub',
    mode: 'group',
    path: '/r',
    name: 'Admin',
    group: 'CTM group',
    groups: ['CTM group', 'Tools'],
    parent: 'menu',
  });
  const t = texts(h.view.render());
  assert.deepEqual(t, ['New group from project…', 'Remove from group', 'Move to group', '●', 'Tools']);
  assert.ok(!t.includes('CTM group'));
});

test('group popup for an ungrouped project hides Remove', async () => {
  const h = await harness(undefined, {
    overlay: 'sub',
    mode: 'group',
    path: '/r',
    name: 'Admin',
    group: null,
    groups: ['CTM group', 'Tools'],
    parent: 'menu',
  });
  const t = texts(h.view.render());
  assert.ok(!t.includes('Remove from group'));
  assert.deepEqual(t, ['New group from project…', 'Move to group', '●', 'CTM group', '●', 'Tools']);
});

test('Move to group runs set-group and refreshes', async () => {
  const h = await harness(undefined, {
    overlay: 'sub',
    mode: 'group',
    path: '/r',
    name: 'Admin',
    group: 'CTM group',
    groups: ['CTM group', 'Tools'],
    parent: 'menu',
  });
  const tree = h.view.render();
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Tools')).attrs.on_click({}, h.cx);
  assert.deepEqual(Array.from(h.state.calls.at(-1).args), ['projects', 'set-group', '/r', 'Tools']);
  assert.equal(typeof h.state.shared.get('orca.projects.rev'), 'number');
  assert.deepEqual(h.state.overlays, [{ close: 'sub' }, { close: 'menu' }]);
});

test('new group dialog prefills, rejects duplicates, creates', async () => {
  const h = await harness(undefined, {
    overlay: 'dlg',
    mode: 'new-group',
    path: '/r',
    name: 'Coduct.CTM.UserApp',
    groups: ['CTM group'],
  });
  let tree = h.view.render();
  const input = nodes(tree).find((n) => n.kind === 'Input')?.path;
  assert.equal(input?.value(), 'Coduct.CTM.UserApp group');

  input.set_value('ctm GROUP');
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Create')).attrs.on_click({}, h.cx);
  assert.equal(h.state.calls.length, 0);
  tree = h.view.render();
  assert.ok(texts(tree).includes('A group with that name already exists — use Move to group'));

  input.set_value('New one');
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Create')).attrs.on_click({}, h.cx);
  assert.deepEqual(Array.from(h.state.calls.at(-1).args), ['projects', 'set-group', '/r', 'New one']);
  assert.equal(typeof h.state.shared.get('orca.projects.rev'), 'number');
  assert.deepEqual(h.state.overlays, [{ close: 'dlg' }]);
});

test('clicking subRow drills down in place with Back and preserves icons', async () => {
  const h = await harness(
    (args) => args[0] === 'apps' && args[1] === 'list'
      ? { installed: [{ id: 'zed', name: 'Zed', icon: 'data/app-icons/zed.png' }], chosen: ['zed'] }
      : {},
    { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin' }
  );
  let tree = h.view.render();
  nodes(tree).find((n) => n.attrs.id === 'open-in').attrs.on_click({}, h.cx);
  await h.flush();
  assert.equal(h.state.overlays.length, 0);
  tree = h.view.render();
  assert.ok(texts(tree).includes('‹ Back'));
  assert.ok(texts(tree).includes('Zed'));
  assert.ok(nodes(tree).some((n) => n.kind === 'image' && n.path === 'data/app-icons/zed.png'));

  nodes(tree).find((n) => n.attrs.id === 'open-in-back').attrs.on_click({}, h.cx);
  tree = h.view.render();
  assert.ok(texts(tree).includes('Open in'));
  assert.ok(texts(tree).includes('Project Group'));
});

test('group popup notifies on set-group error without refreshing', async () => {
  const h = await harness(
    () => ({ error: 'Not a git repository' }),
    { overlay: 'sub', mode: 'group', path: '/r', name: 'Admin', group: 'CTM group', groups: ['CTM group', 'Tools'], parent: 'menu' }
  );
  const tree = h.view.render();
  await nodes(tree).find((n) => n.attrs.on_click && texts(n).includes('Tools')).attrs.on_click({}, h.cx);
  assert.equal(h.state.notifications.length, 1);
  assert.equal(h.state.notifications[0].level, 'error');
  assert.equal(h.state.notifications[0].body, 'Not a git repository');
  assert.equal(h.state.shared.has('orca.projects.rev'), false);
});

test('clicking Project Group drills down in place with Back', async () => {
  const h = await harness(undefined, { overlay: 'menu', mode: 'header', saved: true, path: '/repo', name: 'Admin', group: 'CTM', groups: ['CTM', 'Tools'] });
  let tree = h.view.render();
  nodes(tree).find((n) => n.attrs.id === 'project-group').attrs.on_click({}, h.cx);
  assert.equal(h.state.overlays.length, 0);
  tree = h.view.render();
  assert.ok(texts(tree).includes('‹ Back'));
  assert.ok(texts(tree).includes('New group from project…'));
  assert.ok(texts(tree).includes('Tools'));

  nodes(tree).find((n) => n.attrs.id === 'group-back').attrs.on_click({}, h.cx);
  tree = h.view.render();
  assert.ok(texts(tree).includes('Project Group'));
});

test('new-group Input is styled and dialog height fits inline error', async () => {
  const h = await harness(undefined, { overlay: 'dlg', mode: 'new-group', path: '/r', name: 'App', groups: ['App group'] });
  const tree = h.view.render();
  const inputNode = nodes(tree).find((n) => n.kind === 'Input');
  assert.equal(inputNode?.attrs.h, 30);
  assert.equal(inputNode?.attrs.border, 1);
});

test('worktree cards are indented; only the selected one shows its border', async () => {
  const h = await cardHarness();
  const card = nodes(h.view.render()).find((n) => n.attrs.id === 'card-s1');
  assert.ok(card.attrs.ml > 0);
  assert.equal(card.attrs.border, 1);
  assert.equal(card.attrs.border_color, 'c-border');
  h.state.spaces[0].active = false;
  const idle = nodes(h.view.render()).find((n) => n.attrs.id === 'card-s1');
  assert.equal(idle.attrs.border, 1, 'same width, so selecting never shifts the card');
  assert.equal(idle.attrs.border_color, '#00000000');
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

test('new worktree starts its agent with the full-access flag', async () => {
  const h = await harness(args => args[0] === 'worktree-add' ? { path: '/wt/new' } : {});
  await h.flush();
  h.state.shared.set('orca.projects.request', { id: 7, kind: 'worktree', repo: '/r', base: 'main', name: '', agent: { name: 'Codex', run: ['codex', '--no-daemon'] } });
  h.view.check(h.cx);
  await h.flush();
  const created = h.state.runs.find(r => r.cmd === 'space.new');
  assert.deepEqual(Array.from(created.args.argv), ['codex', '--dangerously-bypass-approvals-and-sandbox', '--no-daemon']);
});


test('Projects accepts pane focus and draws a focused sidebar border', async () => {
  const h = await harness();
  await h.flush();
  assert.equal(h.state.focused, false);
  assert.equal(h.view.render().attrs.border_color, '#00000000');
  await h.command('focus');
  assert.equal(h.state.focused, true);
  const tree = h.view.render();
  assert.equal(tree.attrs.id, 'projects');
  assert.equal(tree.attrs.track_focus, h.view.handle);
  assert.equal(tree.attrs.border_color, 'c-accent');
  h.state.focused = false;
  assert.equal(h.view.render().attrs.border_color, '#00000000');
  const metadata = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../mods/projects/mod.json'), 'utf8'));
  assert.equal(metadata.focusable, true);
});

async function navigationHarness() {
  const h = await harness();
  await h.flush();
  h.view.startedAt = 0;
  h.state.spaces = [
    {id: 's1', folder: '/one', branch: 'main', active: true, name: 'one', tabs: []},
    {id: 's2', folder: '/two', branch: 'feature', active: false, name: 'two', tabs: []},
  ];
  h.view.saved = [{path: '/one', name: 'One', exists: true}, {path: '/two', name: 'Two', exists: true}];
  h.view.repo.set('/one', {primary: '/one', linked: false});
  h.view.repo.set('/two', {primary: '/two', linked: false});
  h.view.render();
  await h.command('focus');
  return h;
}

test('Projects j/k move in visible order, highlight and scroll the cursor, and Enter opens the worktree', async () => {
  const h = await navigationHarness();
  assert.equal(h.view.navKey, 'worktree:s1');
  await h.command('next');
  assert.equal(h.view.navKey, h.view.navigation[2].key);
  await h.command('next');
  assert.equal(h.view.navKey, 'worktree:s2');
  const tree = h.view.render();
  const card = nodes(tree).find(node => node.attrs.id === 'card-s2');
  assert.equal(card.attrs.border_color, 'c-accent');
  assert.equal(h.state.scrolls.at(-1), h.view.navigation[3].index);
  assert.equal(h.state.runs.length, 0);
  await h.command('open');
  assert.equal(h.state.runs.at(-1).cmd, 'space.select');
  assert.equal(h.state.runs.at(-1).args.id, 's2');
  await h.command('previous');
  assert.equal(h.view.navKey, h.view.navigation[2].key);
});

test('Projects h/l fold project groups and navigate parent and child entries', async () => {
  const h = await navigationHarness();
  await h.command('next');
  const project = h.view.navigation[2];
  await h.command('collapse');
  assert.equal(h.view.collapsed.has(project.collapseKey), true);
  h.view.render();
  assert.equal(h.view.navigation.some(entry => entry.key === 'worktree:s2'), false);
  await h.command('expand');
  assert.equal(h.view.collapsed.has(project.collapseKey), false);
  h.view.render();
  await h.command('expand');
  assert.equal(h.view.navKey, 'worktree:s2');
  await h.command('collapse');
  assert.equal(h.view.navKey, project.key);
  assert.ok(h.state.storageSets.some(([key]) => key === 'projects.collapsed'));
});

test('Projects supports Vim ends and counts, and leaves modified pane shortcuts untouched', async () => {
  const h = await navigationHarness();
  const key = (key, modifiers = {}) => h.view.keyDown({key, modifiers}, h.cx);
  key('g'); key('g');
  assert.equal(h.view.navKey, h.view.navigation[0].key);
  key('2'); key('j');
  assert.equal(h.view.navKey, h.view.navigation[2].key);
  key('g', {shift: true});
  assert.equal(h.view.navKey, h.view.navigation.at(-1).key);
  const selected = h.view.navKey;
  key('h', {platform: true, shift: true});
  key('l', {platform: true, shift: true});
  assert.equal(h.view.navKey, selected);
  assert.equal(h.state.runs.length, 0);
  key('escape');
  assert.equal(h.state.runs.at(-1).cmd, 'pane.go');
  assert.equal(h.state.runs.at(-1).args.direction, 'right');
});

test('Projects navigation follows named groups and reselects safely when rows disappear', async () => {
  const h = await navigationHarness();
  h.view.saved = h.view.saved.map(project => ({...project, group: 'Work'}));
  h.view.render();
  await h.command('first');
  const group = h.view.navigation[0];
  assert.ok(group.key.startsWith('group:'));
  await h.command('expand');
  assert.equal(h.view.navigation.find(entry => entry.key === h.view.navKey).parent, group.key);
  h.view.selectNavigation('worktree:s2', h.cx);
  h.state.spaces = h.state.spaces.filter(space => space.id !== 's2');
  h.view.saved = h.view.saved.filter(project => project.path !== '/two');
  h.view.render();
  assert.equal(h.view.navKey, 'worktree:s1');
});

test('Projects Activity view also supports selecting agents with j/k and Enter', async () => {
  const h = await navigationHarness();
  h.view.view = 'activity';
  h.state.agents = [
    {address: 'a1', space: 's1', pane: 'p1', status: 'idle', program: {name: 'Codex'}},
    {address: 'a2', space: 's2', pane: 'p2', status: 'idle', program: {name: 'Claude'}},
  ];
  h.view.render();
  await h.command('first');
  await h.command('next');
  assert.equal(h.view.navKey, 'agent:a2');
  await h.command('open');
  assert.equal(h.state.runs.at(-1).cmd, 'pane.focus');
  assert.equal(h.state.runs.at(-1).args.pane, 'p2');
});

test('worktree agents expand with l and participate in j/k navigation and Enter focus', async () => {
  const h = await cardHarness();
  h.view.render();
  await h.command('focus');
  assert.equal(h.view.navKey, 'worktree:s1');
  await h.command('expand');
  assert.equal(h.view.agentsOpen.has('/r'), true);
  h.view.render();
  assert.deepEqual(Array.from(h.view.navigation.filter(entry => entry.agent), entry => entry.key), ['agent:a1', 'agent:a2']);
  await h.command('next');
  assert.equal(h.view.navKey, 'agent:a1');
  let tree = h.view.render();
  assert.equal(nodes(tree).find(node => node.attrs.id === 'agent-a1').attrs.border_color, 'c-accent');
  await h.command('next');
  assert.equal(h.view.navKey, 'agent:a2');
  await h.command('open');
  assert.equal(h.state.runs.at(-1).cmd, 'pane.focus');
  assert.equal(h.state.runs.at(-1).args.pane, 'p2');
  await h.command('collapse');
  assert.equal(h.view.navKey, 'worktree:s1');
  await h.command('collapse');
  assert.equal(h.view.agentsOpen.has('/r'), false);
  h.view.render();
  assert.equal(h.view.navigation.some(entry => entry.agent), false);
});

test('nested agents retain their own mouse cursor selection and scroll handles', async () => {
  const h = await cardHarness();
  h.view.toggleAgents('/r', h.cx);
  const tree = h.view.render();
  const agent = nodes(tree).find(node => node.attrs.id === 'agent-a2');
  let stopped = false;
  agent.attrs.on_mouse_down[1]({}, {...h.cx, stop_propagation() { stopped = true; }});
  assert.equal(stopped, true);
  assert.equal(h.view.navKey, 'agent:a2');
  const entry = h.view.navigation.find(item => item.key === 'agent:a2');
  assert.equal(entry.parent, 'worktree:s1');
  assert.equal(entry.agentIndex, 1);
  assert.ok(entry.agentScroll);
  assert.equal(h.state.scrolls.at(-1), 1);
});


test('Projects Vim motions and Tab stay inside Projects at the list boundaries', async () => {
  const h = await cardHarness();
  h.state.layout = {id: 'root', children: [{id: 'agents', content: {mod: 'orca-agents'}}]};
  h.view.render();
  await h.command('last');
  const last = h.view.navKey;
  await h.command('next');
  assert.equal(h.view.navKey, last);
  await h.command('first');
  const first = h.view.navKey;
  await h.command('previous');
  await h.command('collapse');
  h.view.keyDown({key: 'tab'}, h.cx);
  assert.equal(h.view.navKey, first);
  assert.equal(h.state.runs.length, 0);
});

test('long expanded worktree agent lists reveal the selected agent in their own scroll area', async () => {
  const h = await cardHarness();
  h.state.agents = Array.from({length: 10}, (_, i) => ({address: `a${i}`, space: 's1', pane: `p${i}`, status: 'idle', program: {name: 'Codex'}}));
  h.view.toggleAgents('/r', h.cx);
  const tree = h.view.render();
  assert.equal(nodes(tree).find(node => node.attrs.id === 'agents-list-s1').attrs.h, 168);
  await h.command('last');
  assert.equal(h.view.navKey, 'agent:a9');
  assert.equal(h.state.scrolls.at(-1), 9);
});


test('restored expanded agent lists allocate scroll handles before the first render', async () => {
  const h = await harness(undefined, null, {'projects.agentsOpen': JSON.stringify(['/r'])});
  await h.flush();
  assert.equal(h.view.agentsOpen.has('/r'), true);
  assert.ok(h.view.agentScrolls.get('/r'));
  assert.doesNotThrow(() => h.view.render());
});
