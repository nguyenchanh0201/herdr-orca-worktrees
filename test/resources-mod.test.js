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

async function panelHarness(opts = {}) {
  const storage = new Map(opts.storage ?? []);
  const state = {
    shared: new Map(opts.shared ?? []),
    execs: [],
    runs: [],
    overlays: [],
    notices: 0,
    storage,
  };
  const pending = [];
  const cx = {
    notify() { state.notices++; },
    stop_propagation() {},
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); },
    timer: { every() {} },
  };
  const context = {
    ...await import('../mods/orca-resources-panel/fmt.js'),
    View: class {},
    div: () => element('div'),
    svg: (p) => element('svg', p),
    h_flex: () => element('h_flex'),
    v_flex: () => element('v_flex'),
    shared: (k) => state.shared.get(k),
    setShared: (k, v) => state.shared.set(k, v),
    checking: () => false,
    run: (cmd, args) => state.runs.push({ cmd, args }),
    openOverlay: (spec) => state.overlays.push({ open: JSON.parse(JSON.stringify(spec)) }),
    closeOverlay: (id) => state.overlays.push({ close: id }),
    props: () => ({ overlay: 'ov-1', height: 500 }),
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    theme: () => ({
      foreground: 'c-fg', muted: 'c-muted', dim: 'c-dim', border: 'c-border',
      hover: 'c-hover', selected: 'c-selected', working: 'c-working', blocked: 'c-blocked',
      popover: 'c-popover', raised: 'c-raised', accent: 'c-accent', background: 'c-bg',
    }),
    exec: async (cmd, argv, options) => {
      assert.notEqual(cmd, 'orca');
      assert.ok(!String(cmd).includes('Orca.app'));
      for (const a of argv ?? []) assert.ok(!String(a).includes('Orca.app'));
      state.execs.push({ cmd, argv: argv ?? [], options });
      return opts.exec ? opts.exec(cmd, argv ?? [], options) : { code: 0, stdout: '{}', stderr: '' };
    },
    Date,
  };
  const source = fs.readFileSync(require.resolve('../mods/orca-resources-panel/main.js'), 'utf8')
    .replace(/^import\b[\s\S]*?;\n/gm, '')
    .replace('export default class OrcaResourcesPanel', 'class OrcaResourcesPanel');
  vm.runInNewContext(`${source}\nthis.Mod = OrcaResourcesPanel;`, context);
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

function sampleSnap() {
  return {
    at: 1794911400000,
    cpu: 3.5,
    rss: 2296381, // 2.19 GB
    count: 2,
    herdr: { cpu: 0.5, rss: 102400 },
    herdrHistory: [102400, 102400],
    history: { '/repos/herdr-orca-worktrees/wt': [500000, 700000] },
    other: [],
    projects: [
      {
        key: '/repos/herdr-orca-worktrees',
        name: 'herdr-orca-worktrees',
        cpu: 3.0,
        rss: 2193981,
        worktrees: [
          {
            key: '/repos/herdr-orca-worktrees/wt',
            name: 'feat/projects-sidebar',
            cpu: 3.0,
            rss: 2193981,
            terminals: [
              { address: 't1', pid: 101, label: 'small-mem-high-cpu', agent: 'claude-code', cpu: 2.5, rss: 500000 },
              { address: 't2', pid: 102, label: 'big-mem-low-cpu', agent: 'zsh', cpu: 0.5, rss: 1693981 },
            ],
          },
        ],
      },
    ],
  };
}

test('fmt copies agree', async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const f = await import('../mods/orca-resources-panel/fmt.js');
  for (const kb of [0, 512, 738099, 1048575, 1048576, 1121976]) {
    assert.equal(f.fmtMem(kb), t.fmtMem(kb));
  }
  for (const cpu of [0, 2.44, 105.67]) {
    assert.equal(f.fmtCpu(cpu), t.fmtCpu(cpu));
  }
});

test('header, tabs and summary', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  const tree = h.view.render(h.cx);
  const all = texts(tree);
  for (const expected of ['Resource Manager', 'Refresh', 'Resources', 'PTYs', '3.5%', '2.19 GB', 'Σ RSS']) {
    assert.ok(all.includes(expected), `expected ${expected} in ${JSON.stringify(all)}`);
  }
});

test('rows nest project, worktree, terminal, sorted by mem', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  const all = texts(h.view.render(h.cx));
  const iProj = all.indexOf('HERDR-ORCA-WORKTREES');
  const iWt = all.indexOf('feat/projects-sidebar');
  const iBig = all.indexOf('big-mem-low-cpu');
  const iSmall = all.indexOf('small-mem-high-cpu');
  const iHerdr = all.indexOf('Herdr');
  assert.ok(iProj >= 0 && iWt > iProj && iBig > iWt && iSmall > iBig && iHerdr > iSmall, `bad order: ${JSON.stringify(all)}`);
  assert.ok(!all.includes('Herdr.app & herdr-core'));
});

test('clicking CPU header sorts by cpu', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  let tree = h.view.render(h.cx);
  const cpuHeader = nodes(tree).find((n) => n.attrs.id === 'sort-cpu');
  assert.ok(cpuHeader && cpuHeader.attrs.on_click);
  cpuHeader.attrs.on_click({}, h.cx);
  tree = h.view.render(h.cx);
  const all = texts(tree);
  assert.ok(all.indexOf('small-mem-high-cpu') < all.indexOf('big-mem-low-cpu'));
});

test('clicking a terminal row focuses it', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  const tree = h.view.render(h.cx);
  const row = nodes(tree).find((n) => n.attrs.id === 'res-term-t1');
  assert.ok(row && row.attrs.on_click);
  row.attrs.on_click({}, h.cx);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.runs)), [{ cmd: 'pane.focus', args: { terminal: 't1' } }]);
});

test('Metric details unfolds the explanation', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  let tree = h.view.render(h.cx);
  assert.ok(!texts(tree).some((s) => s.includes('%cpu')));
  const fold = nodes(tree).find((n) => n.attrs.id === 'metric-details-toggle');
  assert.ok(fold && fold.attrs.on_click);
  fold.attrs.on_click({}, h.cx);
  const all = texts(h.view.render(h.cx));
  assert.ok(all.some((s) => s.includes('%cpu')));
  assert.ok(all.some((s) => s.includes('RSS')));
});

test('open flag', async () => {
  const h = await panelHarness({ shared: [['orca.resources', sampleSnap()]] });
  assert.equal(h.state.shared.get('orca.resources.open'), true);
});

function snapWithOther() {
  const s = sampleSnap();
  s.other = [{ address: 't9', pid: 900, label: 'stray', agent: 'zsh', cpu: 0.1, rss: 1000 }];
  return s;
}

test('PTYs tab lists only Herdr terminals with counts', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', snapWithOther()]],
    storage: [['resources.tab', 'ptys']],
  });
  const all = texts(h.view.render(h.cx));
  assert.ok(all.includes('2 Herdr terminals on this computer'), `got ${JSON.stringify(all)}`);
  assert.ok(!all.includes('Other terminals'));
  assert.ok(all.includes('2'));
});

test('Select all then End selected asks once and kills each', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    storage: [['resources.tab', 'ptys']],
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
  });
  let tree = h.view.render(h.cx);
  const selectAll = nodes(tree).find((n) => n.attrs.id === 'pty-select-all');
  assert.ok(selectAll && selectAll.attrs.on_click);
  selectAll.attrs.on_click({}, h.cx);

  tree = h.view.render(h.cx);
  const endSel = nodes(tree).find((n) => n.attrs.id === 'pty-end-selected');
  assert.ok(endSel && endSel.attrs.on_click);
  endSel.attrs.on_click({}, h.cx);

  tree = h.view.render(h.cx);
  const all = texts(tree);
  assert.ok(
    all.includes('End 2 terminals and their processes? One is running Claude Code.'),
    `missing confirm in ${JSON.stringify(all)}`,
  );

  const confirmBtn = nodes(tree).find((n) => n.attrs.id === 'pty-confirm-end');
  assert.ok(confirmBtn && confirmBtn.attrs.on_click);
  confirmBtn.attrs.on_click({}, h.cx);
  await h.flush();

  const kills = h.state.execs.filter((e) => e.cmd === 'hc' && e.argv[0] === 'kill').map((e) => e.argv[1]);
  assert.deepEqual(kills.sort(), ['t1', 't2']);
  assert.ok(h.state.shared.get('orca.resources.refresh')?.at);
});

test('a failed kill shows inline and others still end', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    storage: [['resources.tab', 'ptys']],
    exec: (_cmd, argv) => {
      if (argv[0] === 'kill' && argv[1] === 't1') return { code: 1, stdout: '', stderr: 'gone' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  let tree = h.view.render(h.cx);
  nodes(tree).find((n) => n.attrs.id === 'pty-select-all').attrs.on_click({}, h.cx);
  tree = h.view.render(h.cx);
  nodes(tree).find((n) => n.attrs.id === 'pty-end-selected').attrs.on_click({}, h.cx);
  tree = h.view.render(h.cx);
  nodes(tree).find((n) => n.attrs.id === 'pty-confirm-end').attrs.on_click({}, h.cx);
  await h.flush();

  const kills = h.state.execs.filter((e) => e.cmd === 'hc' && e.argv[0] === 'kill').map((e) => e.argv[1]);
  assert.deepEqual(kills.sort(), ['t1', 't2']);
  const all = texts(h.view.render(h.cx));
  assert.ok(all.some((s) => s.includes('gone')), `expected gone in ${JSON.stringify(all)}`);
});

test('End selected is disabled at 0', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    storage: [['resources.tab', 'ptys']],
  });
  const tree = h.view.render(h.cx);
  const endSel = nodes(tree).find((n) => n.attrs.id === 'pty-end-selected');
  assert.ok(endSel);
  assert.equal(endSel.attrs.on_click, undefined);
});

test('↗ jumps to the terminal', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    storage: [['resources.tab', 'ptys']],
  });
  const tree = h.view.render(h.cx);
  const jump = nodes(tree).find((n) => n.attrs.id === 'pty-jump-t1');
  assert.ok(jump && jump.attrs.on_click);
  jump.attrs.on_click({}, h.cx);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.runs)), [{ cmd: 'pane.focus', args: { terminal: 't1' } }]);
});

test('unfolding a row shows details', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    storage: [['resources.tab', 'ptys']],
    exec: (cmd, argv) => {
      if (cmd === 'hc' && argv[0] === 'get' && argv[1] === 't1') {
        return {
          code: 0,
          stdout: JSON.stringify({
            address: 't1',
            pid: 101,
            cwd: '/repos/herdr-orca-worktrees/wt',
            created_ms: 1794893899127,
            foreground: { argv: ['claude', '--resume', 'abc'] },
          }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '{}', stderr: '' };
    },
  });
  const tree = h.view.render(h.cx);
  const fold = nodes(tree).find((n) => n.attrs.id === 'pty-fold-t1');
  assert.ok(fold && fold.attrs.on_click);
  fold.attrs.on_click({}, h.cx);
  await h.flush();

  const all = texts(h.view.render(h.cx));
  assert.ok(all.some((s) => s.includes('t1')), `expected t1 in ${JSON.stringify(all)}`);
  assert.ok(all.some((s) => s.includes('claude --resume abc')), `expected argv in ${JSON.stringify(all)}`);
});

test('resources tab keeps row order stable across live updates until Refresh', async () => {
  const snap = sampleSnap();
  const h = await panelHarness({ shared: [['orca.resources', snap]] });
  let all = texts(h.view.render(h.cx));
  assert.ok(all.indexOf('big-mem-low-cpu') < all.indexOf('small-mem-high-cpu'));

  // Live update flips memory values: order must stay locked.
  const updated = sampleSnap();
  updated.projects[0].worktrees[0].terminals[0].rss = 5000000;
  updated.projects[0].worktrees[0].terminals[1].rss = 100000;
  h.state.shared.set('orca.resources', updated);
  all = texts(h.view.render(h.cx));
  assert.ok(all.indexOf('big-mem-low-cpu') < all.indexOf('small-mem-high-cpu'));

  // Clicking Refresh clears the locked order so the next render re-sorts.
  const refresh = nodes(h.view.render(h.cx)).find((n) => n.attrs.id === 'res-refresh');
  refresh.attrs.on_click({}, h.cx);
  all = texts(h.view.render(h.cx));
  assert.ok(all.indexOf('small-mem-high-cpu') < all.indexOf('big-mem-low-cpu'));
});

test('resources tab End button confirms and kills terminal without focusing it', async () => {
  const h = await panelHarness({
    shared: [['orca.resources', sampleSnap()]],
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
  });
  let tree = h.view.render(h.cx);
  const endBtn = nodes(tree).find((n) => n.attrs.id === 'res-end-t1');
  assert.ok(endBtn && endBtn.attrs.on_click);
  endBtn.attrs.on_click({ stop_propagation() {} }, h.cx);
  assert.equal(h.state.runs.length, 0);

  tree = h.view.render(h.cx);
  assert.ok(texts(tree).includes('End 1 terminal and their processes? One is running Claude Code.'));
  nodes(tree).find((n) => n.attrs.id === 'pty-confirm-end').attrs.on_click({}, h.cx);
  await h.flush();

  const kills = h.state.execs.filter((e) => e.cmd === 'hc' && e.argv[0] === 'kill').map((e) => e.argv[1]);
  assert.deepEqual(kills, ['t1']);
});



