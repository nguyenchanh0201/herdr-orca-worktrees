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

test("gitview Shift+P uses the Changes key table and serializes pushes without changing the draft", async () => {
  const calls = [], notices = [];
  let finish, task;
  const context = vm.createContext({View: class {}, pushRepo: where => {
    calls.push(where);
    return new Promise(resolve => {finish = resolve;});
  }, notify: value => notices.push(value), message: error => error.message});
  vm.runInContext(readModSource("gitview") + "\nglobalThis.Mod = GitList;", context);
  const view = new context.Mod();
  Object.assign(view, {mode: "files", scope: "worktree", typing: false,
    work: {where: {root: "/repo", on: null}}, showsFocus: () => true,
    commitRunning: () => false, loads: {busy: () => false, run: (_cx, name, fn) => {task = fn({});}},
    refresh: () => calls.push("refresh"), commitInput: {value: () => "keep this draft"},
  });
  const modeContext = vm.createContext({});
  const modeSource = fs.readFileSync(path.join(__dirname, "../mods/gitview/modes.js"), "utf8");
  vm.runInContext(modeSource.replace(/^import .*;\n/gm, "").replace(/export /g, "") + "\nglobalThis.modes = MODES;", modeContext);
  const shortcut = modeContext.modes.files.keys.find(entry => entry.on.P).on.P;
  assert.equal(modeContext.modes.log.keys.some(entry => entry.on.P), false);
  for (const change of [{typing:true}, {mode:"log"}, {scope:"branch"}, {showsFocus:()=>false}]) {
    const prior = Object.fromEntries(Object.keys(change).map(key => [key, view[key]]));
    Object.assign(view, change); shortcut(view, {}); Object.assign(view, prior);
  }
  assert.equal(calls.length, 0);
  shortcut(view, {}); shortcut(view, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, "/repo");
  finish({remote:"origin"}); await task;
  assert.equal(view.pushing, false);
  assert.equal(view.commitInput.value(), "keep this draft");
  assert.equal(notices[0].title, "Pushed");
  assert.equal(calls.at(-1), "refresh");
  context.pushRepo = async () => {throw new Error("rejected by remote");};
  view.flash = {set: text => calls.push(text)};
  shortcut(view, {}); await task;
  assert.equal(view.pushing, false);
  assert.equal(notices.at(-1).title, "Push failed");
  assert.ok(calls.includes("rejected by remote"));
});

test("gitview push bridge publishes to a local bare remote and reports Git failures", async t => {
  const os = require("node:os");
  const {spawnSync, execFileSync} = require("node:child_process");
  const {makeRepo} = require("./helpers/repo");
  const repo = makeRepo({files: {"a.txt": "one\n"}});
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "gitview-push-"));
  t.after(() => {repo.cleanup(); fs.rmSync(remote,{recursive:true,force:true});});
  execFileSync("git", ["init", "--bare", remote], {stdio:"ignore"});
  execFileSync("git", ["-C", repo.primary, "remote", "add", "origin", remote]);
  const context = vm.createContext({
    appHome: () => "/app", readTextFile: async () => JSON.stringify({node:process.execPath,cli:path.join(__dirname,"../bin/orca-wt.js")}),
    exec: async (cmd,args) => {const r=spawnSync(cmd,Array.from(args),{encoding:"utf8"}); return {code:r.status,stdout:r.stdout,stderr:r.stderr};},
  });
  const source = fs.readFileSync(path.join(__dirname,"../mods/gitview/engine.js"),"utf8");
  vm.runInContext(source.replace(/^import .*;\n/gm, "").replace(/export /g, "") + "\nglobalThis.push = pushRepo; globalThis.pushState = pushState;",context);
  const before = await context.pushState({root:repo.primary,on:null});
  assert.equal(before.publish, true);
  assert.equal(before.available, true);
  const result = await context.push({root:repo.primary,on:null});
  assert.equal(result.remote,"origin");
  assert.equal((await context.pushState({root:repo.primary,on:null})).ahead, 0);
  fs.writeFileSync(path.join(repo.primary, "outgoing.txt"), "outgoing\n");
  execFileSync("git", ["-C", repo.primary, "add", "outgoing.txt"]);
  execFileSync("git", ["-C", repo.primary, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "outgoing"], {stdio: "ignore"});
  const outgoing = await context.pushState({root:repo.primary,on:null});
  assert.equal(outgoing.ahead, 1);
  assert.equal(outgoing.publish, false);
  const branch = execFileSync("git", ["-C", repo.primary, "branch", "--show-current"], {encoding:"utf8"}).trim();
  assert.equal(execFileSync("git",["-C",repo.primary,"rev-parse","--abbrev-ref","@{upstream}"],{encoding:"utf8"}).trim(), `origin/${branch}`);
  execFileSync("git",["-C",repo.primary,"remote","remove","origin"]);
  await assert.rejects(context.push({root:repo.primary,on:null}), /Add a remote/);
  await assert.rejects(context.push({root:repo.primary,on:"remote-machine"}), /local repositories/);
});

test("clean Changes offers counted Push or first publish; edits, drafts and up-to-date branches keep Commit", () => {
  const context = vm.createContext({View: class {}});
  vm.runInContext(readModSource("gitview") + "\nglobalThis.Mod = GitList;", context);
  const view = new context.Mod();
  let files = 0, draft = "";
  view.work = {files: () => files, status: {pushState: {ahead: 3, available: true, publish: false}}};
  view.commitInput = {value: () => draft};
  assert.equal(view.primaryPush().label, "Push 3 ↑");
  view.pushing = true;
  assert.equal(view.primaryPush().label, "Pushing…");
  assert.equal(view.primaryPush().busy, true);
  view.pushing = false;
  files = 1; assert.equal(view.primaryPush(), null);
  files = 0; draft = "commit draft"; assert.equal(view.primaryPush(), null);
  draft = ""; view.work.status.pushState.ahead = 0;
  assert.equal(view.primaryPush(), null);
  view.work.status.pushState.publish = true;
  assert.equal(view.primaryPush().label, "Push · publish ↑");
  view.work.status.pushState.available = false;
  assert.equal(view.primaryPush(), null);
  view.work.status.pushState = null;
  assert.equal(view.primaryPush(), null);
});

test("primary action renders Push and dispatches push, with repeated clicks disabled while pushing", () => {
  const elements = [];
  function el() {
    const rec = {children:[]}; elements.push(rec);
    const proxy = new Proxy({}, {get(_,key) {
      if(key === 'when') return (ok,fn) => ok ? fn(proxy) : proxy;
      if(key === 'id') return id => {rec.id=id; return proxy;};
      if(key === 'child') return child => {rec.children.push(child); return proxy;};
      if(key === 'on_click') return fn => {rec.click=fn; return proxy;};
      return () => proxy;
    }});
    return proxy;
  }
  const context=vm.createContext({div:el,h_flex:el,Textarea:{new:el}});
  const source=fs.readFileSync(path.join(__dirname,'../mods/gitview/chrome.js'),'utf8');
  vm.runInContext(source.replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nglobalThis.commitBox=commitBox;',context);
  let commits=0,pushes=0;
  const render = busy => {
    elements.length=0;
    context.commitBox({}, {value:()=>''},false,false,false,()=>commits++,false,{label:busy?'Pushing…':'Push 3 ↑',busy,run:()=>pushes++});
    return elements.find(e=>e.id==='gitview-commit');
  };
  let button=render(false);
  assert.ok(button.children.includes('Push 3 ↑'));
  button.click({},{}); assert.equal(pushes,1); assert.equal(commits,0);
  button=render(true); button.click({},{}); assert.equal(pushes,1);
});
