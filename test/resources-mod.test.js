const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const COMBINED_PS = 'pid=,ppid=,pcpu=,rss=,comm=';

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
    checking: opts.checking ?? false,
    now: 0,
    window: Object.hasOwn(opts, 'window') ? opts.window : () => ({ active: true }),
    notices: 0,
    timers: [],
  };
  const pending = [];
  const cx = {
    notify() { state.notices++; },
    stop_propagation() {},
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); },
    timer: {
      every(ms, fn) {
        const timer = { ms, fn, canceled: false, cancel() { this.canceled = true; } };
        state.timers.push(timer);
        return timer;
      },
    },
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
    window: state.window,
    Date: { now: () => state.now },
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
    tickAt(now) {
      state.now = now;
      for (const timer of state.timers) {
        if (!timer.canceled) timer.fn(cx);
      }
    },
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
    if (cmd === 'ps' && argv[1] === COMBINED_PS) {
      return { code: 0, stdout: ' 100 1 1.5 1000 /bin/zsh\n 200 1 2.0 2000 /bin/zsh\n 300 1 0.5 500 /bin/bash\n 400 1 0.5 100 /x/herdr-core\n', stderr: '' };
    }
    if (cmd === 'hc' && argv[0] === 'ls') {
      return {
        code: 0,
        stdout: JSON.stringify({
          terminals: [
            { address: 't1', agent: 'claude-code', cwd: '/repos/app/wt1', state: 'live', where: 'wt1 / 1' },
            { address: 't2', agent: 'zsh', cwd: '/repos/app/wt1', state: 'live', where: 'wt1 / 2' },
            { address: 't3', agent: 'bash', cwd: '/tmp', state: 'live', where: 'tmp' },
            { address: 'remote/t4', state: 'live' },
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
  assert.equal(snap.other[0].rss, 500);
  assert.equal(snap.herdr.rss, 100);
  assert.ok(!sampleCommands(h).includes('hc get remote/t4 --json'));

  h.state.execs.length = 0;
  h.view.sample(h.cx);
  await h.flush();
  assert.deepEqual(sampleCommands(h), ['hc ls --json', 'ps -axo pid=,ppid=,pcpu=,rss=,comm=']);
});

test('pids are looked up once', async () => {
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === COMBINED_PS) {
      return { code: 0, stdout: ' 100 1 1.0 1000 /bin/zsh\n', stderr: '' };
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function processScans(h) {
  return h.state.execs.filter((e) => e.cmd === 'ps' && e.argv[1] === COMBINED_PS).length;
}

for (const [name, open, window, interval] of [
  ['popup open with the main window inactive', true, () => ({ active: false }), 2000],
  ['popup closed and active window', false, () => ({ active: true }), 15000],
  ['popup closed and inactive window', false, () => ({ active: false }), 30000],
  ['popup closed without focus data', false, () => ({}), 15000],
  ['popup closed without a window API', false, undefined, 15000],
  ['popup closed with an unavailable window', false, () => { throw new Error('unavailable'); }, 15000],
]) {
  test(`schedules by completion time with ${name}`, async () => {
    const firstScan = deferred();
    const h = await chipHarness((cmd) => cmd === 'hc' ? ok(EMPTY_TERMINALS) : firstScan.promise, {
      shared: [['orca.resources.open', open]],
      window,
    });
    assert.equal(h.state.timers[0].ms, 1000);
    assert.equal(processScans(h), 1);

    // Even a collection longer than the cadence cannot overlap periodic work.
    const completedAt = 31000;
    h.tickAt(completedAt);
    await Promise.resolve();
    assert.equal(processScans(h), 1);
    firstScan.resolve(ok(VALID_PS));
    await h.flush();

    h.tickAt(completedAt + interval - 1);
    await h.flush();
    assert.equal(processScans(h), 1);
    h.tickAt(completedAt + interval);
    await h.flush();
    assert.equal(processScans(h), 2);
  });
}

test('coalesces refresh and focus return into one follow-up during collection', async () => {
  const firstScan = deferred();
  let active = false;
  let scans = 0;
  const h = await chipHarness((cmd) => {
    if (cmd === 'hc') return ok(EMPTY_TERMINALS);
    return ++scans === 1 ? firstScan.promise : ok(VALID_PS);
  }, { window: () => ({ active }) });

  active = true;
  h.state.shared.set('orca.resources.refresh', { at: 1000 });
  h.tickAt(1000);
  h.state.shared.set('orca.resources.refresh', { at: 2000 });
  h.tickAt(2000);
  await Promise.resolve();
  assert.equal(processScans(h), 1);

  firstScan.resolve(ok(VALID_PS));
  await h.flush();
  assert.equal(processScans(h), 2);
  h.tickAt(3000);
  await h.flush();
  assert.equal(processScans(h), 2);
});

test('focus return triggers a sample before the periodic deadline', async () => {
  let active = false;
  const h = await chipHarness((cmd) => cmd === 'hc' ? ok(EMPTY_TERMINALS) : ok(VALID_PS), {
    window: () => ({ active }),
  });
  await h.flush();
  active = true;
  h.tickAt(1000);
  await h.flush();
  assert.equal(processScans(h), 2);
});

test('opening the popup and refresh tokens trigger prompt samples through the tick', async () => {
  let active = true;
  const h = await chipHarness((cmd) => cmd === 'hc' ? ok(EMPTY_TERMINALS) : ok(VALID_PS), {
    window: () => ({ active }),
    shared: [['orca.resources.refresh', { at: 1 }]],
  });
  await h.flush();
  h.tickAt(1000);
  await h.flush();
  assert.equal(processScans(h), 1);

  active = false;
  h.state.shared.set('orca.resources.open', true);
  h.tickAt(2000);
  await h.flush();
  assert.equal(processScans(h), 2);

  for (const at of [2500, 3500]) {
    // Manual Refresh and successful PTY kills publish the same token shape.
    const previousScans = processScans(h);
    h.state.shared.set('orca.resources.refresh', { at });
    h.view.render(h.cx);
    await h.flush();
    assert.equal(processScans(h), previousScans);
    h.tickAt(at + 500);
    await h.flush();
    assert.equal(processScans(h), previousScans + 1);
  }
});

test('destroy cancels ticks and discards pending refresh and late collection', async () => {
  const scan = deferred();
  const previous = { rss: 100, count: 0 };
  const h = await chipHarness((cmd) => cmd === 'hc' ? ok(EMPTY_TERMINALS) : scan.promise, {
    shared: [['orca.resources', previous]],
  });
  h.state.shared.set('orca.resources.refresh', { at: 1000 });
  h.tickAt(1000);
  h.view.destroy();
  assert.equal(h.state.timers[0].canceled, true);
  scan.resolve(ok(VALID_PS));
  await h.flush();

  h.tickAt(31000);
  await h.flush();
  assert.equal(processScans(h), 1);
  assert.equal(h.state.shared.get('orca.resources'), previous);
  assert.equal(h.state.notices, 0);
});

test('a queued refresh waits for both legacy commands after one rejects', async () => {
  const legacyStats = deferred();
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'hc') return ok(EMPTY_TERMINALS);
    if (argv[1] === COMBINED_PS) return { code: 1, stderr: 'ps: comm: keyword not found' };
    if (argv[1] === LEGACY_PS) return legacyStats.promise;
    if (argv[1] === LEGACY_COMM) throw new Error('exec failed');
  });

  h.state.shared.set('orca.resources.refresh', { at: 1000 });
  h.tickAt(1000);
  // Allow the rejected command to settle without releasing the stats command.
  await new Promise((resolve) => setImmediate(resolve));
  const listingsWhilePending = h.state.execs.filter(({ cmd }) => cmd === 'hc').length;
  legacyStats.resolve(ok('5 1 1.0 100\n'));
  await h.flush();

  assert.equal(listingsWhilePending, 1);
  assert.equal(h.state.execs.filter(({ cmd }) => cmd === 'hc').length, 2);
  assert.equal(processScans(h), 1);
});

test('destroy during the combined probe prevents legacy fallback commands', async () => {
  const scan = deferred();
  const previous = { rss: 100, count: 0 };
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'hc') return ok(EMPTY_TERMINALS);
    if (argv[1] === COMBINED_PS) return scan.promise;
    return ok('5 1 1.0 100\n');
  }, { shared: [['orca.resources', previous]] });

  h.view.destroy();
  scan.resolve({ code: 1, stderr: 'ps: comm: keyword not found' });
  await h.flush();

  assert.deepEqual(sampleCommands(h), ['hc ls --json', 'ps -axo pid=,ppid=,pcpu=,rss=,comm=']);
  assert.equal(h.state.shared.get('orca.resources'), previous);
  assert.equal(h.state.notices, 0);
});

test('checking mode starts no timers or commands', async () => {
  const h = await chipHarness(() => assert.fail('unexpected exec'), { checking: true });
  h.view.render(h.cx);
  await h.flush();
  assert.equal(h.state.timers.length, 0);
  assert.deepEqual(h.state.execs, []);
});

test('non-repo place becomes its own project', async () => {
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'ps' && argv[1] === COMBINED_PS) return { code: 0, stdout: ' 100 1 1.0 1000 /bin/zsh\n', stderr: '' };
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
    if (cmd === 'ps' && argv[1] === COMBINED_PS) {
      return {
        code: 0,
        stdout: [
          ' 101 1 1.0 448790 /bin/zsh',
          ' 102 1 1.0 448790 /bin/zsh',
          ' 103 1 1.0 448790 /bin/zsh',
          ' 104 1 1.0 448790 /bin/zsh',
          ' 105 1 1.0 448793 /bin/zsh',
        ].join('\n'),
        stderr: '',
      };
    }
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

const VALID_PS = '5 1 1.0 100 /x/herdr-core\n';
const LEGACY_PS = 'pid=,ppid=,pcpu=,rss=';
const LEGACY_COMM = 'pid=,comm=';
const EMPTY_TERMINALS = '{"terminals":[]}';

function ok(stdout) {
  return { code: 0, stdout, stderr: '' };
}

function sampleCommands(h) {
  return h.state.execs.map(({ cmd, argv }) => [cmd, ...argv].join(' ')).sort();
}

for (const [name, combined] of [
  ['explicitly unsupported', { code: 1, stdout: '', stderr: 'ps: comm: keyword not found' }],
  ['unusable at startup', ok('5 1 1.0 100\n')],
]) {
  test(`uses the legacy scans on later samples if the combined format is ${name}`, async () => {
    const h = await chipHarness((cmd, argv) => {
      if (cmd === 'hc') return ok(EMPTY_TERMINALS);
      if (argv[1] === COMBINED_PS) return combined;
      if (argv[1] === LEGACY_PS) return ok('5 1 1.0 100\n');
      if (argv[1] === LEGACY_COMM) return ok('5 /x/herdr-core\n');
    });

    await h.flush();
    const initial = h.state.shared.get('orca.resources');
    assert.equal(initial?.herdr.rss, 100);
    assert.deepEqual(sampleCommands(h), [
      'hc ls --json', 'ps -axo pid=,comm=', 'ps -axo pid=,ppid=,pcpu=,rss=',
      'ps -axo pid=,ppid=,pcpu=,rss=,comm=',
    ]);

    h.state.execs.length = 0;
    h.view.sample(h.cx);
    await h.flush();
    assert.notEqual(h.state.shared.get('orca.resources'), initial);
    assert.deepEqual(sampleCommands(h), [
      'hc ls --json', 'ps -axo pid=,comm=', 'ps -axo pid=,ppid=,pcpu=,rss=',
    ]);
  });
}

test('retries the combined format when an unusable startup scan and its legacy fallback fail', async () => {
  let startup = true;
  const h = await chipHarness((cmd, argv) => {
    if (cmd === 'hc') return ok(EMPTY_TERMINALS);
    if (argv[1] === COMBINED_PS) return ok(startup ? '' : VALID_PS);
    if (argv[1] === LEGACY_PS) return ok('5 1 1.0 100\n');
    if (argv[1] === LEGACY_COMM) return { ...ok('5 /x/herdr-core\n'), code: 1 };
  });

  await h.flush();
  assert.equal(h.state.shared.has('orca.resources'), false);
  startup = false;
  h.state.execs.length = 0;
  h.view.sample(h.cx);
  await h.flush();
  assert.equal(h.state.shared.get('orca.resources')?.herdr.rss, 100);
  assert.deepEqual(sampleCommands(h), ['hc ls --json', 'ps -axo pid=,ppid=,pcpu=,rss=,comm=']);
});

test('retains the snapshot across transient process scan failures and keeps using the combined format', async () => {
  let processResult = ok(VALID_PS);
  const h = await chipHarness((cmd) => cmd === 'hc' ? ok(EMPTY_TERMINALS) : processResult);

  await h.flush();
  const initial = h.state.shared.get('orca.resources');
  assert.equal(initial?.herdr.rss, 100);
  for (const failed of [ok('garbled data'), { ...ok(VALID_PS), code: 1, stderr: 'temporarily unavailable' }]) {
    processResult = failed;
    h.state.execs.length = 0;
    h.view.sample(h.cx);
    await h.flush();
    assert.equal(h.state.shared.get('orca.resources'), initial);
    assert.deepEqual(sampleCommands(h), ['hc ls --json', 'ps -axo pid=,ppid=,pcpu=,rss=,comm=']);
  }

  processResult = ok('5 1 1.0 200 /x/herdr-core\n');
  h.view.sample(h.cx);
  await h.flush();
  const next = h.state.shared.get('orca.resources');
  assert.equal(next.herdr.rss, 200);
  assert.deepEqual(Array.from(next.herdrHistory), [100, 200]);
});

test('retains the snapshot for invalid terminal listings and publishes a valid empty listing', async () => {
  let terminalResult = ok(JSON.stringify({
    terminals: [{ address: 't1', state: 'live', pid: 6, labels: {} }],
  }));
  const h = await chipHarness((cmd) => cmd === 'hc' ? terminalResult : ok(VALID_PS));

  await h.flush();
  const initial = h.state.shared.get('orca.resources');
  assert.equal(initial?.other[0].address, 't1');

  for (const failed of [ok('malformed'), ok('{}'), ok('null'), { ...ok(EMPTY_TERMINALS), code: 1 }]) {
    terminalResult = failed;
    h.view.sample(h.cx);
    await h.flush();
    assert.equal(h.state.shared.get('orca.resources'), initial);
  }

  terminalResult = ok(EMPTY_TERMINALS);
  h.view.sample(h.cx);
  await h.flush();
  const next = h.state.shared.get('orca.resources');
  assert.notEqual(next, initial);
  assert.equal(next.count, 0);
  assert.equal(next.other.length, 0);
  assert.equal(next.herdr.rss, 100);
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



