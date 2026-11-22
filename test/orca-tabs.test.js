const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("orca-tabs/main.js matches upstream tabs/main.js outside Orca customizations", (t) => {
  const upstreamPath = path.join(os.homedir(), ".config/herdr-app/mods/tabs/main.js");
  if (!fs.existsSync(upstreamPath)) {
    t.skip("upstream ~/.config/herdr-app/mods/tabs/main.js not present");
    return;
  }

  const orcaTabsPath = path.join(__dirname, "../mods/orca-tabs/main.js");
  const orcaTabs = fs.readFileSync(orcaTabsPath, "utf8");
  const upstream = fs.readFileSync(upstreamPath, "utf8");

  const stripped = orcaTabs
    .replace(/^\/\/ Copied from Herdr [^\n]*\n/, "")
    .replace(/[ \t]*\/\/ ORCA-TOGGLE start[\s\S]*?\/\/ ORCA-TOGGLE end\n/, "")
    .replace(/[ \t]*\/\/ ORCA-GIT start[\s\S]*?\/\/ ORCA-GIT end\n/g, "")
    .replace('let enabled =', 'const enabled =')
    .replace('init(_p, cx)', 'init()')
    .replaceAll("mods/orca-tabs/", "mods/tabs/");

  assert.equal(stripped, upstream);
});

test("Changes command opens and focuses the unified panel and migrates per-space choices", async () => {
  const vm = require("node:vm");
  const {readModSource} = require("./helpers/modsource");
  const calls = [];
  let deliver;
  const context = vm.createContext({
    View: class {},
    ScrollHandle: {new: () => ({})},
    localStorage: {getItem: () => JSON.stringify({space1: "git", space2: "files"})},
    nextCommand: () => new Promise(resolve => { deliver = resolve; }),
    run: (command, args) => calls.push({command, args}),
  });
  vm.runInContext(readModSource("orca-tabs") + "\nglobalThis.Mod = Tabs;", context);
  const view = new context.Mod();
  view.init({}, {spawn: fn => fn()});
  assert.equal(view.panels.space1, "changes");
  assert.equal(view.panels.space2, "files");
  deliver("changes");
  await new Promise(setImmediate);
  assert.deepEqual(calls.map(call => call.command), ["layout.select", "layout.show", "orca-commits.focus"]);
  assert.equal(calls[0].args.child, "changes");
});
