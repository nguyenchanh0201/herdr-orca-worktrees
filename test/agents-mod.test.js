const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModSource} = require('./helpers/modsource');
const {enableGitPanel} = require('../scripts/enable-git-panel');

function element() {
  const node = {attrs: {}, kids: []};
  const el = new Proxy(node, {get(target, key) {
    if (key in target) return target[key];
    if (key === 'child') return child => { node.kids.push(child); return el; };
    if (key === 'children') return children => { node.kids.push(...children); return el; };
    if (key === 'when') return (condition, fn) => condition ? fn(el) : el;
    return (...args) => { node.attrs[key] = args.length === 1 ? args[0] : args; return el; };
  }});
  return el;
}

function harness() {
  const state = {agents: [], terminals: [], runs: [], scrolls: [], focused: false, shared: new Map()};
  let deliver;
  const cx = {notify() {}, stop_propagation() {}, timer: {every() {}},
    focus_handle: () => ({focus() { state.focused = true; }, is_focused: () => state.focused}),
    spawn: fn => fn(cx),
  };
  const colors = new Proxy({accent: 'accent', border: 'border'}, {get: (t, k) => t[k] ?? `color-${String(k)}`});
  const root = {id: 'root', children: [{id: 'spaces', content: {mod: 'projects'}}]};
  const context = {
    View: class {}, div: element, h_flex: element, v_flex: element, svg: element, image: element,
    ScrollHandle: {new: () => ({scroll_to_item: i => state.scrolls.push(i)})},
    nextCommand: () => new Promise(resolve => { deliver = resolve; }), checking: () => false,
    props: () => ({}), theme: () => colors, layout: () => root,
    agents: () => state.agents, terminals: () => state.terminals, focused: () => ({}),
    spaces: () => [{id: 'space', tabs: [{id: 'tab', name: 'Task', named: true}]}], panes: () => [],
    shared: key => state.shared.get(key), setShared: (k, v) => state.shared.set(k, v),
    localStorage: {getItem() { return null; }, setItem() {}, removeItem() {}},
    setAgentOrder() {}, window: () => ({platform: 'macos'}),
    run: (command, args) => state.runs.push({command, args}), openOverlay() {}, closeOverlay() {},
  };
  vm.runInNewContext(readModSource('orca-agents') + '\nglobalThis.Mod = Agents;', context);
  const view = new context.Mod(); view.init({}, cx);
  state.agents = [{address: 'a1', pane: 'p1', tab: 'tab', space: 'space', space_name: 'Repo', status: 'working', seq: 1, program: {name: 'Codex'}}];
  return {state, view, cx, async command(command) { deliver(command); await new Promise(setImmediate); }};
}

function nodes(tree) { return tree && typeof tree === 'object' ? [tree, ...tree.kids.flatMap(nodes)] : []; }

test('Agents j/k navigate groups and agents; Enter focuses the selected terminal', async () => {
  const h = harness(); h.view.render(h.cx);
  await h.command('focus'); await h.command('first');
  assert.ok(h.view.navKey.startsWith('section:'));
  await h.command('next');
  assert.equal(h.view.navKey, 'agent:a1');
  const tree = h.view.render(h.cx);
  assert.equal(nodes(tree).find(node => node.attrs.id === 'ag-a1').attrs.border_color, 'accent');
  await h.command('open');
  assert.equal(h.state.runs.at(-1).command, 'pane.focus');
  assert.equal(h.state.runs.at(-1).args.pane, 'p1');
});

test('Agents sub-agent motion folds with h/l and Enter peeks an unattached sub-agent', async () => {
  const h = harness();
  h.state.terminals = [{address: 'child', parent: 'a1', state: 'live', status: 'idle', name: 'Worker'}];
  h.view.render(h.cx);
  await h.command('first'); await h.command('next'); await h.command('next');
  assert.equal(h.view.navKey, 'sub:a1:child');
  await h.command('open');
  assert.equal(h.state.runs.at(-1).command, 'terminal.peek');
  assert.equal(h.state.runs.at(-1).args.terminal, 'child');
  await h.command('collapse');
  assert.equal(h.view.navKey, 'agent:a1');
  await h.command('collapse');
  h.view.render(h.cx);
  assert.equal(h.view.navigation.some(entry => entry.key === 'sub:a1:child'), false);
  await h.command('expand');
  h.view.render(h.cx);
  assert.equal(h.view.navigation.some(entry => entry.key === 'sub:a1:child'), true);
  await h.command('open');
  assert.equal(h.state.runs.at(-1).command, 'pane.focus');
});

test('Agents retains grouped sorting and pins while motions stay within its pane', async () => {
  const h = harness();
  h.state.shared.set('agents.sort', 'grouped');
  h.state.agents.push({address: 'a2', pane: 'p2', tab: 'tab', space: 'space', space_name: 'Repo', status: 'idle', seq: 2, pinned: true, program: {name: 'Claude'}});
  h.view.render(h.cx);
  assert.equal(h.view.navigation[0].key, 'section:pinned');
  assert.ok(h.view.navigation.some(entry => entry.key === 'section:sp-space'));
  await h.command('first');
  const first = h.view.navKey;
  h.view.keyDown({key: 'k'}, h.cx);
  h.view.keyDown({key: 'h'}, h.cx);
  assert.equal(h.view.navKey, first);
  h.view.keyDown({key: 'tab'}, h.cx);
  await h.command('last');
  const last = h.view.navKey;
  h.view.keyDown({key: 'j'}, h.cx);
  assert.equal(h.view.navKey, last);
  assert.equal(h.state.runs.length, 0);
});

test('Agents migration changes only the shipped Agents block after the custom mod is installed', () => {
  const layout = {id: 'root', children: [{id: 'agents', size: {weight: 1}, content: {mod: 'agents'}}, {id: 'panel-body', type: 'stack', children: []}]};
  enableGitPanel(layout);
  assert.equal(layout.children[0].content.mod, 'agents');
  assert.equal(enableGitPanel(layout, {agents: true}), true);
  assert.equal(layout.children[0].content.mod, 'orca-agents');
  assert.equal(layout.children[0].size.weight, 1);
  assert.equal(enableGitPanel(layout, {agents: true}), false);
  layout.children[0].content.mod = 'my-agents';
  assert.equal(enableGitPanel(layout, {agents: true}), false);
  assert.equal(layout.children[0].content.mod, 'my-agents');
});
