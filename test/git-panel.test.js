const test = require("node:test");
const assert = require("node:assert/strict");
const { enableGitPanel, enableChangesShortcut } = require("../scripts/enable-git-panel");
const vm = require("node:vm");
const { readModSource } = require("./helpers/modsource");

function panelHarness(mode = "history", saved = new Map()) {
  let machine = null;
  const watches = [];
  let folder = "/first";
  const pending = [];
  const handles = [];
  const commands = [];
  let nvimError;
  let tab = "tab1";
  let pane = "pane1";
  const context = vm.createContext({
    View: class {}, checking: () => false, props: () => ({ mode }),
    focused: () => ({ cwd: folder, tab, pane }), spaces: () => [{ active: true, folder, machine }], panes: () => [],
    exec: async () => { if (nvimError) throw new Error(nvimError); return { code: 0 }; },
    nextCommand: () => new Promise(() => {}),
    watchFolder: root => {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      const watch = {root, resolve, canceled: false};
      promise.cancel = () => { watch.canceled = true; resolve([]); };
      watches.push(watch);
      return promise;
    },
    run: (command, args) => commands.push({command, args}),
    shared: key => saved.get(key), setShared: (key, value) => saved.set(key, value),
    InputState: { new: () => { let value = ""; return { on() {}, value: () => value, set_value: next => { value = next; } }; } },
    ScrollHandle: { new: handle }, VirtualListScrollHandle: { new: handle },
  });
  function handle() {
    const calls = [];
    handles.push(calls);
    return { scroll_to_item(...args) { calls.push(args); } };
  }
  vm.runInContext(readModSource("orca-commits") + "\nglobalThis.Mod = OrcaCommits;", context);
  const view = new context.Mod();
  view.cli = args => new Promise(resolve => pending.push({ args, resolve }));
  const cx = {
    focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, timer: { every() {} },
    spawn(fn) { fn(cx); },
  };
  view.init({}, cx);
  return {
    watches, setMachine(value) { machine = value; },
    commands, failNvim(error) { nvimError = error; }, setTab(value) { tab = value; }, setPane(value) { pane = value; },
    view, cx, pending, handles, rows: context.diffRows, setFolder(value) { folder = value; },
    async resolve(index, result) { pending[index].resolve(result); await new Promise(setImmediate); },
    key(key, modifiers = {}) { view.keyDown({ key, modifiers, keystroke: modifiers.control ? `ctrl-${key}` : key }, cx); },
  };
}

test("file diffs number context lines and distinguish patch headers from changed content", () => {
  const rows = panelHarness().rows("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -3,2 +3,2 @@\n context\n--- content\n+++ content\n");
  assert.equal(rows[1].kind, "");
  assert.equal(rows[2].kind, "");
  assert.equal(rows[4].number, 3);
  assert.equal(rows[5].kind, "-");
  assert.equal(rows[5].number, 4);
  assert.equal(rows[6].kind, "+");
  assert.equal(rows[6].number, 4);
});

test("Git panel follows worktree switches and ignores a stale commit response", async () => {
  const h = panelHarness();
  assert.equal(h.view.panel, true);
  assert.equal(h.pending[0].args[1], "/first");
  h.setFolder("/second");
  h.view.syncFolder(h.cx);
  await h.resolve(1, { commits: [{ hash: "second", subject: "Second repo" }] });
  await h.resolve(0, { commits: [{ hash: "first" }] });
  assert.equal(h.view.commits[0].hash, "second");
  assert.deepEqual(Array.from(h.pending[2].args), ["commit-files", "/second", "WORKING"]);
});

test("selecting a commit lists files without fetching a full diff", async () => {
  const h = panelHarness();
  await h.resolve(0, { commits: [{ hash: "abc" }] });
  await h.resolve(1, { files: [{ status: "M", path: "working.txt" }] });
  assert.equal(h.pending.length, 2);
  h.view.select("abc", h.cx);
  await h.resolve(2, { files: [{ status: "R", path: "new.txt", oldPath: "old.txt" }] });
  assert.equal(h.view.selectedFile, null);
  assert.equal(h.pending.length, 3);
  h.view.selectFile(h.view.files[0], h.cx);
  assert.deepEqual(Array.from(h.pending[3].args), ["commit-diff", "/first", "abc", "new.txt", "old.txt"]);
  await h.resolve(3, { diff: "+new\n" });
  assert.equal(h.view.diffRows[0].text, "+new");
});

test("Git panel ignores stale file lists and per-file diffs", async () => {
  const h = panelHarness();
  await h.resolve(0, { commits: [{ hash: "abc" }] });
  h.view.select("abc", h.cx);
  await h.resolve(2, { files: [{ path: "first.txt" }, { path: "second.txt" }] });
  await h.resolve(1, { files: [{ path: "stale.txt" }] });
  assert.equal(h.view.files.length, 2);
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.selectFile(h.view.files[1], h.cx);
  await h.resolve(4, { diff: "+second\n" });
  await h.resolve(3, { diff: "+stale\n" });
  assert.equal(h.view.diffRows[0].text, "+second");
  h.setFolder("/second");
  h.view.syncFolder(h.cx);
  assert.equal(h.view.selectedFile, null);
  assert.equal(h.view.diffRows.length, 0);
});

test("Vim navigation selects commits and files, pages the diff, and scrolls selections into view", async () => {
  const h = panelHarness();
  await h.resolve(0, { commits: [{ hash: "abc" }, { hash: "def" }] });
  await h.resolve(1, { files: [] });
  h.key("j");
  assert.equal(h.view.selected, "abc");
  await h.resolve(2, { files: [{ path: "a.txt" }, { path: "b.txt" }] });
  h.key("l");
  assert.equal(h.view.lane, "files");
  assert.equal(h.view.selectedFile, "a.txt");
  await h.resolve(3, { diff: "+a\n" });
  h.key("j");
  assert.equal(h.view.selectedFile, "b.txt");
  await h.resolve(4, { diff: "+b\n".repeat(100) });
  assert.deepEqual(h.handles[1].at(-1), [1]);
  h.key("l");
  h.key("d", { control: true });
  assert.ok(h.view.diffCursor > 0);
  h.key("G");
  assert.equal(h.view.diffCursor, 99);
  h.key("g"); h.key("g");
  assert.equal(h.view.diffCursor, 0);
  h.key("5"); h.key("j");
  assert.equal(h.view.diffCursor, 5);
  assert.deepEqual(h.handles[2].at(-1), [5, "center"]);
  h.key("h"); h.key("h");
  assert.equal(h.view.lane, "commits");
  h.key("G");
  assert.equal(h.view.selected, "def");
  assert.deepEqual(h.handles[0].at(-1), [2]);
});

test("background refresh preserves the selected commit and file", async () => {
  const h = panelHarness();
  await h.resolve(0, { commits: [{ hash: "abc" }] });
  await h.resolve(1, { files: [{ path: "a.txt" }] });
  h.view.selectFile(h.view.files[0], h.cx);
  await h.resolve(2, { diff: "+old\n" });
  h.view.load(h.cx);
  await h.resolve(3, { commits: [{ hash: "abc" }] });
  await h.resolve(4, { files: [{ path: "a.txt" }] });
  assert.equal(h.view.selectedFile, "a.txt");
  assert.equal(h.pending[5].args[3], "a.txt");
  await h.resolve(5, { diff: "+updated\n" });
  assert.equal(h.view.diffRows[0].text, "+updated");
});

test("Git panel migration preserves custom layout and is idempotent", () => {
  const layout = {
    id: "root", type: "column", background: "custom",
    children: [
      { id: "tabs", content: { mod: "tabs", props: { custom: true } } },
      { id: "panel-body", type: "stack", active: "changes", size: { px: 520 }, children: [
        { id: "files", content: { mod: "my-files" } },
        { id: "changes", content: { mod: "changes" } },
      ] },
    ],
  };
  const before = structuredClone(layout);
  assert.equal(enableGitPanel(layout), true);
  assert.equal(enableGitPanel(layout), false);
  const changes = layout.children[1].children[1];
  assert.equal(changes.id, "changes");
  assert.equal(changes.content.mod, "orca-commits");
  assert.equal(layout.children[0].content.mod, "orca-tabs");
  layout.children[0].content.mod = "tabs";
  changes.content.mod = "changes";
  assert.deepEqual(layout, before);
});

test("Git panel migration leaves unsupported layouts and custom tabs intact", () => {
  const missing = { id: "root", children: [] };
  assert.equal(enableGitPanel(missing), false);
  const custom = { id: "root", children: [
    { id: "tabs", content: { mod: "my-tabs" } },
    { id: "panel-body", type: "stack", children: [] },
  ] };
  enableGitPanel(custom);
  assert.equal(custom.children[0].content.mod, "my-tabs");
});

test("source control separates staged and working versions of the same file", async () => {
  const h = panelHarness("changes");
  assert.equal(h.pending[0].args[0], "git-status");
  await h.resolve(0, { branch: "main", staged: [{path: "a.txt", status: "M"}], changes: [{path: "a.txt", status: "M"}], untracked: [{path: "new.txt"}] });
  h.view.selectFile(h.view.files[0], h.cx);
  assert.equal(h.pending[1].args[2], "STAGED");
  await h.resolve(1, {diff: "+staged\n"});
  h.key("j");
  assert.equal(h.view.selectedSection, "Changes");
  h.key("j");
  assert.equal(h.view.selectedGroup, "UNSTAGED");
  assert.equal(h.pending[2].args[2], "UNSTAGED");
  await h.resolve(2, {diff: "+working\n"});
  h.key("j");
  assert.equal(h.pending[3].args[2], "UNTRACKED");
});

test("source control ignores status and diff responses from an old worktree", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, { changes: [{path: "a.txt", status: "M"}] });
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.load(h.cx);
  h.setFolder("/second"); h.view.syncFolder(h.cx);
  await h.resolve(3, { branch: "second", changes: [] });
  await h.resolve(2, { branch: "old", changes: [{path: "stale"}] });
  await h.resolve(1, {diff: "+stale\n"});
  assert.equal(h.view.status.branch, "second");
  assert.equal(h.view.files.length, 0);
  assert.equal(h.view.diffRows.length, 0);
});

test("staging is serialized and refreshes status after completion", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, { changes: [{path: "new", oldPath: "old", status: "R"}] });
  h.view.action("git-stage", h.view.files[0], h.cx);
  h.view.action("git-stage", null, h.cx);
  assert.equal(h.pending.length, 2);
  assert.deepEqual(Array.from(h.pending[1].args), ["git-stage", "/first", "new", "old"]);
  await h.resolve(1, { ok: true });
  assert.equal(h.pending[2].args[0], "git-status");
  assert.equal(h.view.busy, false);
});

test("commit requires staged changes, keeps failed messages, and clears successful drafts", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, { staged: [], changes: [{path: "a", status: "M"}] });
  h.view.message.set_value("my message"); h.view.drafts["/first"] = "my message";
  h.view.commit(h.cx);
  assert.equal(h.pending.length, 1);
  h.view.status.staged = [{path: "b"}];
  h.view.commit(h.cx);
  assert.deepEqual(Array.from(h.pending[1].args), ["git-commit", "/first", "my message"]);
  await h.resolve(1, { error: "hook rejected" });
  assert.equal(h.view.message.value(), "my message");
  assert.equal(h.view.actionError, "hook rejected");
  await h.resolve(2, { staged: [{path: "b"}] });
  h.view.commit(h.cx);
  await h.resolve(3, { ok: true });
  assert.equal(h.view.message.value(), "");
});

test("commit drafts follow their worktree and typing bypasses Vim navigation", async () => {
  const h = panelHarness("changes");
  h.view.message.set_value("first draft"); h.view.drafts["/first"] = "first draft";
  h.setFolder("/second"); h.view.syncFolder(h.cx);
  assert.equal(h.view.message.value(), "");
  h.setFolder("/first"); h.view.syncFolder(h.cx);
  assert.equal(h.view.message.value(), "first draft");
  h.view.editing = true; h.key("j");
  assert.equal(h.view.count, "");
  assert.equal(h.pending.length, 3);
});

test("Neovim opens the working file in a split using argv, without staging or pasting", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {staged: [{path: "a '$(echo nope).txt", status: "M"}]});
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.openEditor(h.cx);
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(h.pending[2].args), ["git-file", "/first", "a '$(echo nope).txt"]);
  await h.resolve(2, {path: "/first/a '$(echo nope).txt", content: "working"});
  assert.deepEqual(h.commands.map(c => c.command), ["pane.focus", "terminal.open"]);
  assert.equal(h.commands[0].args.pane, "pane1");
  assert.deepEqual(Array.from(h.commands[1].args.argv), ["nvim", "--", "/first/a '$(echo nope).txt"]);
  assert.equal(h.commands[1].args.folder, "/first");
  assert.equal(h.commands[1].args.place, "right");
  assert.ok(h.pending.every(p => p.args[0] !== "git-stage"));
});

test("Neovim startup errors stay in the panel and can be retried", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}]});
  h.view.selectFile(h.view.files[0], h.cx);
  h.failNvim("nvim not found");
  h.view.openEditor(h.cx);
  await new Promise(setImmediate);
  assert.match(h.view.editorError, /nvim not found/);
  assert.equal(h.view.editLoading, false);
  assert.equal(h.commands.length, 0);
  h.failNvim(null);
  h.view.openEditor(h.cx);
  await new Promise(setImmediate);
  await h.resolve(2, {error: "File does not exist"});
  assert.match(h.view.editorError, /File does not exist/);
  assert.equal(h.commands.length, 0);
});

test("pending Neovim opens are canceled by selection, worktree, or tab changes", async () => {
  for (const change of [h => h.view.selectFile(h.view.files[1], h.cx), h => { h.setFolder("/second"); h.view.syncFolder(h.cx); }, h => h.setTab("tab2")]) {
    const h = panelHarness("changes");
    await h.resolve(0, {changes: [{path: "a"}, {path: "b"}]});
    h.view.selectFile(h.view.files[0], h.cx);
    h.view.openEditor(h.cx);
    await new Promise(setImmediate);
    change(h);
    await h.resolve(2, {path: "/first/a", content: "stale"});
    assert.equal(h.commands.length, 0);
  }
});

test("Neovim opens in a tab when no model pane exists; history stays read-only", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}]});
  h.setPane(null);
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.openEditor(h.cx);
  await new Promise(setImmediate);
  await h.resolve(2, {path: "/first/a", content: "working"});
  assert.equal(h.commands[0].command, "terminal.open");
  assert.equal(h.commands[0].args.place, "tab");
  const history = panelHarness();
  history.view.selectedFile = "a";
  history.view.openEditor(history.cx);
  assert.equal(history.pending.length, 1);
  assert.equal(history.commands.length, 0);
});


test("section sizes restore in a fresh view, independently for each layout", () => {
  const saved = new Map();
  const h = panelHarness("changes", saved);
  h.view.rememberSizes("git-sections-panel-changes", [350, 500]);
  h.view.rememberSizes("git-source-panel", [140, 210]);
  h.view.rememberSizes("git-sections-panel-history", [170, 190, 490]);
  h.view.rememberSizes("git-sections-dialog-changes", [300, 700]);
  const reopened = panelHarness("changes", saved);
  assert.equal(reopened.view.savedSize("git-sections-panel-changes", 0, 220), 350);
  assert.equal(reopened.view.savedSize("git-source-panel", 1, 180), 210);
  assert.equal(reopened.view.savedSize("git-sections-panel-history", 2, 300), 490);
  assert.equal(reopened.view.savedSize("git-sections-dialog-changes", 0, 220), 300);
  assert.equal(reopened.view.savedSize("git-source-dialog", 0, 130), 130);
  h.view.rememberSizes("git-source-panel", [NaN, 50]);
  assert.equal(reopened.view.savedSize("git-source-panel", 0, 130), 140);
  saved.set("orca.git.sizes.git-source-dialog", [-5, "broken"]);
  assert.equal(reopened.view.savedSize("git-source-dialog", 0, 130), 130);
  assert.equal(reopened.view.savedSize("git-source-dialog", 1, 180), 180);
});

test("s stages the selected working file and unstages the selected staged version", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {staged: [{path: "new", oldPath: "old"}], changes: [{path: "new"}]});
  h.view.selectFile(h.view.files[1], h.cx);
  h.key("s");
  assert.deepEqual(Array.from(h.pending[2].args), ["git-stage", "/first", "new"]);
  h.key("s");
  assert.equal(h.pending.length, 3);
  await h.resolve(2, {ok: true});
  await h.resolve(3, {staged: [{path: "new", oldPath: "old"}]});
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.lane = "diff";
  h.key("s");
  assert.deepEqual(Array.from(h.pending.at(-1).args), ["git-unstage", "/first", "new", "old"]);
});

test("stage shortcut ignores typing, modified keys, missing selections, and history", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}]});
  h.key("s");
  assert.equal(h.pending.length, 1);
  h.view.selectFile(h.view.files[0], h.cx);
  h.view.editing = true;
  h.key("s");
  h.view.editing = false;
  for (const modifiers of [{platform: true}, {alt: true}, {control: true}]) h.key("s", modifiers);
  assert.equal(h.pending.length, 2);
  h.view.mode = "history";
  h.key("s");
  assert.equal(h.pending.length, 2);
});


test("staged and working group titles remain visible with zero files", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: []});
  assert.deepEqual(Array.from(h.view.sourceEntries(), e => [e.header, e.count]), [["Staged Changes", 0], ["Changes", 0]]);
  h.key("home");
  assert.equal(h.view.selectedSection, "Staged Changes");
  h.key("s");
  h.key("j");
  assert.equal(h.view.selectedSection, "Changes");
  h.key("s");
  assert.equal(h.pending.length, 1);
});

test("selecting Changes stages the group and keeps the header selected after refresh", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}], untracked: [{path: "new"}], conflicts: [{path: "conflict"}]});
  h.view.selectFile(h.view.files[1], h.cx);
  h.view.selectSection("Changes", h.cx);
  assert.equal(h.view.selectedFile, null);
  h.key("s");
  assert.deepEqual(Array.from(h.pending.at(-1).args), ["git-stage", "/first"]);
  h.key("s");
  assert.equal(h.pending.length, 3);
  await h.resolve(2, {ok: true});
  await h.resolve(3, {staged: [{path: "a"}, {path: "new"}], conflicts: [{path: "conflict"}]});
  assert.equal(h.view.selectedSection, "Changes");
  h.key("s");
  assert.equal(h.pending.length, 4);
  h.view.selectSection("Merge Changes", h.cx);
  h.key("s");
  assert.equal(h.pending.length, 4);
});

test("group navigation supports collapse and bulk unstage, including failed operations", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {staged: [{path: "a"}, {path: "b"}], changes: [{path: "c"}]});
  h.key("home");
  assert.equal(h.view.selectedSection, "Staged Changes");
  h.key("h");
  assert.equal(h.view.collapsed["Staged Changes"], true);
  h.key("j");
  assert.equal(h.view.selectedSection, "Changes");
  h.key("k");
  h.key("l");
  assert.equal(h.view.collapsed["Staged Changes"], false);
  h.key("s");
  assert.deepEqual(Array.from(h.pending[1].args), ["git-unstage", "/first"]);
  await h.resolve(1, {error: "Git lock held"});
  await h.resolve(2, {staged: [{path: "a"}, {path: "b"}]});
  assert.match(h.view.actionError, /Git lock held/);
  assert.equal(h.view.selectedSection, "Staged Changes");
  h.key("j");
  assert.equal(h.view.selectedFile, "a");
  assert.equal(h.view.selectedSection, null);
  h.view.selectSection("Staged Changes", h.cx);
  h.setFolder("/second");
  h.view.syncFolder(h.cx);
  assert.equal(h.view.selectedSection, null);
});


test("i focuses the commit message and Escape returns to navigation without changing the draft", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}]});
  let inputFocused = 0;
  let panelFocused = 0;
  h.view.message.focus = () => { inputFocused++; };
  h.view.handle.focus = () => { panelFocused++; };
  h.view.message.set_value("my draft");
  h.key("i", {control: true});
  assert.equal(inputFocused, 0);
  h.key("i");
  assert.equal(inputFocused, 1);
  assert.equal(h.view.editing, true);
  h.key("s");
  assert.equal(h.pending.length, 1);
  h.key("escape");
  assert.equal(panelFocused, 1);
  assert.equal(h.view.editing, false);
  assert.equal(h.view.message.value(), "my draft");
  h.key("home");
  assert.equal(h.view.selectedSection, "Staged Changes");
  h.view.mode = "history";
  h.key("i");
  assert.equal(inputFocused, 1);
});


test("merging Git into Changes retains saved layout sizing, active choice and custom panels", () => {
  const layout = {id: "panel-body", type: "stack", active: "git", size: {px: 640}, children: [
    {id: "changes", content: {mod: "changes"}},
    {id: "git", content: {mod: "orca-commits"}},
    {id: "custom", content: {mod: "custom"}},
  ]};
  assert.equal(enableGitPanel(layout), true);
  assert.equal(layout.active, "changes");
  assert.equal(layout.size.px, 640);
  assert.deepEqual(layout.children.map(child => child.id), ["changes", "custom"]);
  assert.equal(enableGitPanel(layout), false);
  const custom = {id: "panel-body", type: "stack", children: [{id: "changes", content: {mod: "my-changes"}}, {id: "git", content: {mod: "orca-commits"}}]};
  enableGitPanel(custom);
  assert.equal(custom.children[0].content.mod, "my-changes");
  assert.equal(custom.children.length, 2);
});

test("Changes shortcut is scoped to Orca and preserves customized bindings", () => {
  const keys = {global: {"cmd-shift-g": "other.command"}};
  assert.equal(enableChangesShortcut(keys), true);
  assert.equal(keys["layout:orca"]["cmd-shift-g"], "orca-tabs.changes");
  assert.equal(keys.global["cmd-shift-g"], "other.command");
  assert.equal(enableChangesShortcut(keys), false);
  keys["layout:orca"]["cmd-shift-g"] = "my.command";
  assert.equal(enableChangesShortcut(keys), false);
});

test("file watching refreshes local Changes and cancels watches on folder changes and close", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {root: "/first", changes: []});
  assert.equal(h.watches[0].root, "/first");
  h.watches[0].resolve(["/first/a"]);
  await new Promise(setImmediate);
  assert.equal(h.pending[1].args[0], "git-status");
  h.watches[1].resolve(["/first/b"]);
  await new Promise(setImmediate);
  assert.equal(h.pending.length, 2); // Coalesce while status is loading.
  await h.resolve(1, {root: "/first", changes: []});
  assert.equal(h.pending.length, 3);
  await h.resolve(2, {root: "/first", changes: []});
  h.watches[2].resolve(["/first/.git/index"]);
  await new Promise(setImmediate);
  assert.equal(h.pending.length, 3);
  h.setFolder("/second"); h.view.syncFolder(h.cx);
  assert.equal(h.watches[3].canceled, true);
  await h.resolve(3, {root: "/second", changes: []});
  h.view.close();
  assert.equal(h.watches[4].canceled, true);
});

test("remote contexts never load or mutate a local repository with the same folder", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {changes: [{path: "a"}]});
  h.setMachine("server"); h.view.syncFolder(h.cx);
  assert.match(h.view.error, /local workspaces only/);
  assert.equal(h.pending.length, 1);
  h.view.action("git-stage", null, h.cx);
  h.view.load(h.cx);
  assert.equal(h.pending.length, 1);
  h.setMachine(null); h.view.syncFolder(h.cx);
  assert.equal(h.pending.length, 2);
});

test("status supplies separate staged and working line counts and large previews are bounded", async () => {
  const h = panelHarness("changes");
  await h.resolve(0, {staged: [{path: "a"}], changes: [{path: "a"}], stats: {staged: {a: {add: 2, del: 1}}, working: {a: {add: 5, del: 3}}}});
  assert.equal(h.view.files[0].add, 2);
  assert.equal(h.view.files[1].add, 5);
  h.view.selectFile(h.view.files[1], h.cx);
  await h.resolve(1, {diff: "+a\n".repeat(1600)});
  assert.equal(h.view.diffRows.length, 1500);
  assert.equal(h.view.diffLimited, true);
});
