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
    .replaceAll("mods/orca-tabs/", "mods/tabs/");

  assert.equal(stripped, upstream);
});
