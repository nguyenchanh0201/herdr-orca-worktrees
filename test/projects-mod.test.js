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

async function harness(respond = () => ({})) {
  const state = { shared: new Map(), calls: [], spaces: [], agents: [], checking: false, notices: 0 };
  const pending = [];
  const cx = { notify() { state.notices++; }, spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); }, timer: { every() {} } };
  const context = {
    ...await import('../mods/projects/group.js'),
    ...await import('../mods/projects/sleep.js'),
    ...await import('../mods/projects/sidebar.js'),
    View: class {}, div: () => element('div'), svg: p => element('svg', p), image: p => element('image', p),
    h_flex: () => element('h_flex'), v_flex: () => element('v_flex'),
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    localStorage: { getItem: () => null, setItem() {} },
    shared: key => state.shared.get(key), setShared: (k, v) => state.shared.set(k, v),
    spaces: () => state.spaces, panes: () => [], agents: () => state.agents, machines: () => [{ name: null, layout: 'ready' }],
    checking: () => state.checking, layout: () => null, knownAgents: async () => [],
    run() {}, openOverlay() {}, notify() {}, setAgentOrder() {}, pickFolder: async () => '/new',
    theme: () => ({}), home: () => '/home', appHome: () => '/app', readTextFile: async () => null,
    config: { node: 'node', cli: 'cli' },
    exec: async (_cmd, argv, options) => {
      const args = argv.slice(1);
      state.calls.push({ args, options });
      return { code: 0, stdout: JSON.stringify(await respond(args)), stderr: '' };
    },
  };
  const source = fs.readFileSync(require.resolve('../mods/projects/main.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class Projects', 'class Projects');
  vm.runInNewContext(`${source}\nthis.Projects = Projects;`, context);
  const view = new context.Projects();
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

