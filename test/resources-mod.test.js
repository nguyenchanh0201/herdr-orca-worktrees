const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element(kind, path) {
  const node = { kind, path, attrs: {}, kids: [] };
  const proxy = new Proxy(node, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === 'child') target.kids.push(args[0]);
        else if (key === 'children') target.kids.push(...args[0]);
        else if (key === 'when') { if (args[0]) args[1](proxy); }
        else target.attrs[key] = args.length === 1 ? args[0] : args;
        return proxy;
      };
    },
  });
  return proxy;
}

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...tree.kids.flatMap(nodes)];
}

function texts(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return tree.kids.flatMap((c) => (typeof c === 'string' ? [c] : texts(c)));
}

async function chipHarness(execStub, opts = {}) {
  const state = {
    shared: new Map(opts.shared ?? []),
    execs: [],
    runs: [],
    overlays: [],
    spaces: opts.spaces ?? [],
    panes: opts.panes ?? [],
    terminals: opts.terminals ?? [],
    checking: false,
    notices: 0,
    timers: [],
  };
  const pending = [];
  const cx = {
    notify() { state.notices++; },
    stop_propagation() {},
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); },
    timer: { every(ms, fn) { state.timers.push({ ms, fn }); } },
  };
  const context = {
    ...await import('../mods/orca-resources/tree.js'),
    ...await import('../mods/orca-resources/place.js'),
    View: class {},
    div: () => element('div'),
    svg: (p) => element('svg', p),
    h_flex: () => element('h_flex'),
    v_flex: () => element('v_flex'),
    shared: (k) => state.shared.get(k),
    setShared: (k, v) => state.shared.set(k, v),
    spaces: () => state.spaces,
    panes: () => state.panes,
    terminals: () => state.terminals,
    checking: () => state.checking,
    run: (cmd, args) => state.runs.push({ cmd, args }),
    openOverlay: (spec) => state.overlays.push({ open: JSON.parse(JSON.stringify(spec)) }),
    closeOverlay: (id) => state.overlays.push({ close: id }),
    props: () => null,
    localStorage: { getItem: () => null, setItem() {} },
    theme: () => ({
      foreground: 'c-fg', muted: 'c-muted', dim: 'c-dim', border: 'c-border',
      hover: 'c-hover', selected: 'c-selected', working: 'c-working', blocked: 'c-blocked',
    }),
    config: { node: 'node', cli: 'cli' },
    exec: async (cmd, argv, options) => {
      assert.notEqual(cmd, 'orca');
      assert.ok(!String(cmd).includes('Orca.app'));
      for (const a of argv ?? []) assert.ok(!String(a).includes('Orca.app'));
      state.execs.push({ cmd, argv: argv ?? [], options });
      return execStub(cmd, argv ?? [], options);
    },
    Date,
  };
  const source = fs.readFileSync(require.resolve('../mods/orca-resources/main.js'), 'utf8')
    .replace(/^import\b[\s\S]*?;\n/gm, '')
    .replace('export default class OrcaResources', 'class OrcaResources');
  vm.runInNewContext(`${source}\nthis.Mod = OrcaResources;`, context);
  const view = new context.Mod();
  view.init({}, cx);
  return {
    view,
    cx,
    state,
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

test('placeOf copies agree on all cases', async () => {
  const a = await import('../mods/projects/group.js');
  const b = await import('../mods/orca-resources/place.js');
  const cases = [
    [null, []],
    [{ folder: '/a', tabs: [] }, []],
    [{ folder: '/a', tabs: [{ id: 'tab1' }] }, [{ tab: 'tab1', cwd: '/b' }]],
    [{ folder: '/a', tabs: [{ id: 'tab1' }] }, [{ tab: 'tab2', cwd: '/b' }]],
    [{ tabs: [{ id: 'tab1' }] }, [{ tab: 'tab1', cwd: '' }]],
  ];
  for (const [sp, ps] of cases) {
    assert.equal(b.placeOf(sp, ps), a.placeOf(sp, ps));
  }
});

test('sample publishes a snapshot', async () => {
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === 'pid=,ppid=,pcpu=,rss=') {
      return { code: 0, stdout: ' 100 1 1.5 1000\n 200 1 2.0 2000\n 300 1 0.5 500\n', stderr: '' };
    }
    if (cmd === 'ps' && argv[1] === 'pid=,comm=') {
      return { code: 0, stdout: ' 100 /bin/zsh\n', stderr: '' };
    }
    if (cmd === 'hc' && argv[0] === 'ls') {
      return {
        code: 0,
        stdout: JSON.stringify({
          terminals: [
            { address: 't1', agent: 'claude-code', cwd: '/repos/app/wt1', state: 'live', where: 'wt1 / 1' },
            { address: 't2', agent: 'zsh', cwd: '/repos/app/wt1', state: 'live', where: 'wt1 / 2' },
            { address: 't3', agent: 'bash', cwd: '/tmp', state: 'live', where: 'tmp' },
          ],
        }),
        stderr: '',
      };
    }
    if (cmd === 'hc' && argv[0] === 'get') {
      const addr = argv[1];
      if (addr === 't1') return { code: 0, stdout: JSON.stringify({ pid: 100, labels: { 'herdr.space': 's1' } }), stderr: '' };
      if (addr === 't2') return { code: 0, stdout: JSON.stringify({ pid: 200, labels: { 'herdr.space': 's1' } }), stderr: '' };
      if (addr === 't3') return { code: 0, stdout: JSON.stringify({ pid: 300, labels: {} }), stderr: '' };
    }
    if (cmd === 'node' && argv[1] === 'info') {
      return { code: 0, stdout: JSON.stringify({ primary: '/repos/my-app' }), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  }, {
    spaces: [{ id: 's1', name: 'wt1', folder: '/repos/app/wt1', machine: null, tabs: [] }],
  });

  await h.flush();
  const snap = h.state.shared.get('orca.resources');
  assert.ok(snap);
  assert.equal(snap.count, 2);
  assert.equal(snap.projects.length, 1);
  assert.equal(snap.projects[0].name, 'my-app');
  assert.equal(snap.other.length, 1);
  assert.equal(snap.other[0].address, 't3');
});

test('pids are looked up once', async () => {
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === 'pid=,ppid=,pcpu=,rss=') {
      return { code: 0, stdout: ' 100 1 1.0 1000\n', stderr: '' };
    }
    if (cmd === 'ps' && argv[1] === 'pid=,comm=') {
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'hc' && argv[0] === 'ls') {
      return { code: 0, stdout: JSON.stringify({ terminals: [{ address: 't1', agent: 'zsh', cwd: '/r', state: 'live' }] }), stderr: '' };
    }
    if (cmd === 'hc' && argv[0] === 'get') {
      return { code: 0, stdout: JSON.stringify({ pid: 100, labels: { 'herdr.space': 's1' } }), stderr: '' };
    }
    if (cmd === 'node' && argv[1] === 'info') {
      return { code: 0, stdout: JSON.stringify({ primary: '/r' }), stderr: '' };
    }
    return { code: 0, stdout: '{}', stderr: '' };
  }, { spaces: [{ id: 's1', name: 'r', folder: '/r', machine: null, tabs: [] }] });

  await h.flush();
  h.view.sample(h.cx);
  await h.flush();
  const gets = h.state.execs.filter((e) => e.cmd === 'hc' && e.argv[0] === 'get' && e.argv[1] === 't1');
  assert.equal(gets.length, 1);
});

test('skips a sample while one is running', async () => {
  let resolvePs;
  const neverPs = new Promise((r) => { resolvePs = r; });
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === 'pid=,ppid=,pcpu=,rss=') return neverPs;
    return { code: 0, stdout: '{}', stderr: '' };
  });

  await Promise.resolve();
  h.view.sample(h.cx);
  await Promise.resolve();
  assert.equal(h.state.execs.filter((e) => e.cmd === 'ps' && e.argv[1] === 'pid=,ppid=,pcpu=,rss=').length, 1);
  resolvePs({ code: 0, stdout: '', stderr: '' });
  await h.flush();
});

test('non-repo place becomes its own project', async () => {
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === 'pid=,ppid=,pcpu=,rss=') return { code: 0, stdout: ' 100 1 1.0 1000\n', stderr: '' };
    if (cmd === 'ps' && argv[1] === 'pid=,comm=') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'hc' && argv[0] === 'ls') {
      return { code: 0, stdout: JSON.stringify({ terminals: [{ address: 't1', agent: 'zsh', cwd: '/tmp/scratch-dir', state: 'live' }] }), stderr: '' };
    }
    if (cmd === 'hc' && argv[0] === 'get') {
      return { code: 0, stdout: JSON.stringify({ pid: 100, labels: { 'herdr.space': 's1' } }), stderr: '' };
    }
    if (cmd === 'node' && argv[1] === 'info') {
      return { code: 1, stdout: JSON.stringify({ error: 'not a git repository' }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }, { spaces: [{ id: 's1', name: 'scratch-dir', folder: '/tmp/scratch-dir', machine: null, tabs: [] }] });

  await h.flush();
  const snap = h.state.shared.get('orca.resources');
  assert.equal(snap.projects.length, 1);
  assert.equal(snap.projects[0].name, 'scratch-dir');
});

test('chip text and click', async () => {
  // 2.14 GB = 2.14 * 1048576 = 2243953 KB (5 terminals * 448790 = 2243950 -> 2.14 GB)
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === 'pid=,ppid=,pcpu=,rss=') {
      return {
        code: 0,
        stdout: [
          ' 101 1 1.0 448790',
          ' 102 1 1.0 448790',
          ' 103 1 1.0 448790',
          ' 104 1 1.0 448790',
          ' 105 1 1.0 448793',
        ].join('\n'),
        stderr: '',
      };
    }
    if (cmd === 'ps' && argv[1] === 'pid=,comm=') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'hc' && argv[0] === 'ls') {
      return {
        code: 0,
        stdout: JSON.stringify({
          terminals: [1, 2, 3, 4, 5].map((i) => ({ address: `t${i}`, agent: 'zsh', cwd: '/r', state: 'live' })),
        }),
        stderr: '',
      };
    }
    if (cmd === 'hc' && argv[0] === 'get') {
      const idx = Number(argv[1].slice(1));
      return { code: 0, stdout: JSON.stringify({ pid: 100 + idx, labels: { 'herdr.space': 's1' } }), stderr: '' };
    }
    if (cmd === 'node' && argv[1] === 'info') {
      return { code: 0, stdout: JSON.stringify({ primary: '/r' }), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }, { spaces: [{ id: 's1', name: 'r', folder: '/r', machine: null, tabs: [] }] });

  await h.flush();
  const tree = h.view.render(h.cx);
  const allTexts = texts(tree);
  assert.ok(allTexts.includes('2.14 GB'), `expected 2.14 GB in ${JSON.stringify(allTexts)}`);
  assert.ok(allTexts.includes('5'), `expected 5 in ${JSON.stringify(allTexts)}`);

  const chipNode = nodes(tree).find((n) => n.attrs.on_mouse_down);
  assert.ok(chipNode);
  chipNode.attrs.on_mouse_down[1]({ bounds: { x: 400, y: 800, width: 150, height: 28 } }, h.cx);
  assert.equal(h.state.overlays.length, 1);
  assert.equal(h.state.overlays[0].open.mod, 'orca-resources-panel');
});
