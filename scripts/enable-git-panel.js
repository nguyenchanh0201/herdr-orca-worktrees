const fs = require("node:fs");

// Upgrade the saved Orca layout without replacing its custom panes or sizing.
function enableGitPanel(layout) {
  function find(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = find(child, id);
      if (found) return found;
    }
  }
  const body = find(layout, "panel-body");
  if (body?.type !== "stack" || !Array.isArray(body.children)) return false;
  let changed = false;
  if (!body.children.some(child => child.id === "git")) {
    body.children.push({ id: "git", type: "block", content: { mod: "orca-commits" } });
    changed = true;
  }
  const tabs = find(layout, "tabs");
  if (tabs?.content?.mod === "tabs") {
    tabs.content.mod = "orca-tabs";
    changed = true;
  }
  return changed;
}

if (require.main === module) {
  const file = process.argv[2];
  const layout = JSON.parse(fs.readFileSync(file, "utf8"));
  if (enableGitPanel(layout)) {
    fs.copyFileSync(file, `${file}.before-git`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(layout, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
    console.log("added Git panel to your Orca layout (backup: orca.json.before-git)");
  }
}

module.exports = { enableGitPanel };
