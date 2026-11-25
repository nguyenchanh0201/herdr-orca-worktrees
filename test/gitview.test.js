const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {readModSource} = require("./helpers/modsource");
const {enableGitPanel} = require("../scripts/enable-git-panel");

const status = () => ({sections: [
  {id: "staged", title: "Staged Changes", files: [{path: "staged.txt"}]},
  {id: "changes", title: "Changes", files: [{path: "working.txt"}, {path: "new.txt"}]},
]});

test("standard install migrates the Orca Changes slot while preserving custom panels", () => {
  const content = {mod: "orca-commits", props: {custom: true}};
  const layout = {id: "panel-body", type: "stack", children: [{id: "changes", content}]};
  assert.equal(enableGitPanel(layout, {gitview: true}), true);
  assert.equal(layout.children[0].content.mod, "gitview");
  assert.equal(layout.children[0].content.props.replaces, content);
  assert.equal(enableGitPanel(layout, {gitview: true}), false);
  layout.children[0].content = {mod: "custom-changes"};
  assert.equal(enableGitPanel(layout, {gitview: true}), false);
  assert.equal(layout.children[0].content.mod, "custom-changes");
});

test("vendored gitview Vim navigation reaches headers and keeps selection through refresh and tree changes", async () => {
  const {FileList} = await import("../mods/gitview/filelist.js");
  const list = new FileList(status(), {});
  list.rebuild(false);
  list.select(list.edge(false));
  assert.equal(list.row().kind, "header");
  assert.equal(list.row().section.id, "staged");
  list.select(list.step(1));
  assert.equal(list.row().file.path, "staged.txt");
  list.select(list.step(1));
  assert.equal(list.row().kind, "header");
  assert.equal(list.row().section.id, "changes");
  assert.deepEqual(list.filesOf(list.row()), ["working.txt", "new.txt"]);
  list.update(status(), {});
  assert.equal(list.row().kind, "header");
  list.rebuild(true);
  list.selectIntoFolder();
  assert.equal(list.row().kind, "header");
  list.select(list.step(-1));
  assert.equal(list.row().file.path, "staged.txt");
  const history = new FileList(status(), {commit: "abc"});
  history.rebuild(false);
  assert.equal(history.edge(false).kind, "file");
});

test("Enter on a gitview section dispatches every file in that section and respects history and scope guards", async () => {
  const {FileList} = await import("../mods/gitview/filelist.js");
  const actions = [];
  const context = vm.createContext({View: class {},
    event() {}, allowed: (op, section) => op === (section === "staged" ? "unstage" : "stage"),
    MODES: {files: {actsOnWork: true}, commit: {}},
  });
  vm.runInContext(readModSource("gitview") + "\nglobalThis.Mod = GitList;", context);
  const view = new context.Mod();
  view.work = new FileList(status(), {root: "/repo"});
  view.work.rebuild(false);
  view.list = () => view.work;
  view.mode = "files";
  view.scope = "worktree";
  view.act = (args, where) => actions.push({args: Array.from(args), where});
  for (const [section, op, files] of [["changes", "stage", ["working.txt", "new.txt"]], ["staged", "unstage", ["staged.txt"]]]) {
    view.work.select(view.work.find(`section:${section}`));
    view.enter({});
    assert.deepEqual(actions.at(-1).args, [op, "--section", section, "--", ...files]);
    assert.equal(actions.at(-1).where.root, "/repo");
  }
  view.mode = "commit";
  view.enter({});
  view.mode = "files";
  view.scope = "branch";
  view.enter({});
  assert.equal(actions.length, 2);
});

test("gitview section action buttons render without hovering", () => {
  const buttons = [];
  function element() {
    const proxy = new Proxy({}, {get(_target, key) {
      if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy;
      if (key === "children") return () => proxy;
      return () => proxy;
    }});
    return proxy;
  }
  const context = vm.createContext({div: element, h_flex: element,
    opsFor: id => id === "staged" ? ["unstage"] : ["stage", "discard"],
    iconButton: (_t, id, _icon, tip, action) => {buttons.push({id, tip, action}); return {};},
  });
  const source = fs.readFileSync(path.join(__dirname, "../mods/gitview/listview.js"), "utf8");
  vm.runInContext(source.replace(/^import .*;\n/gm, "").replace(/export /g, "") + "\nglobalThis.renderRow = renderRow;", context);
  for (const [id, op] of [["changes", "stage"], ["staged", "unstage"]]) {
    buttons.length = 0;
    let received;
    const row = {kind: "header", key: id, section: status().sections.find(s => s.id === id)};
    context.renderRow(row, {t: {}, onAction: (action, target) => {received = {action, target};}});
    assert.deepEqual(buttons.map(b => b.id), [`${op}-${id}`]);
    buttons[0].action({});
    assert.equal(received.action, op);
    assert.equal(received.target, row);
  }
});
