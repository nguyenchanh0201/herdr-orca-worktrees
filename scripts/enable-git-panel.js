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
  const changes = body.children.find(child => child.id === "changes");
  const git = body.children.find(child => child.id === "git" && child.content?.mod === "orca-commits");
  if (!changes) {
    body.children.push({ ...(git || { type: "block" }), id: "changes", content: { mod: "orca-commits" } });
    changed = true;
  } else if (changes.content?.mod === "changes") {
    changes.content = { ...changes.content, mod: "orca-commits" };
    changed = true;
  }
  if (body.children.find(child => child.id === "changes")?.content?.mod === "orca-commits" && git) {
    body.children = body.children.filter(child => child !== git);
    if (body.active === "git") body.active = "changes";
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
    console.log("merged Git into Changes in your Orca layout (backup: orca.json.before-git)");
  }
  const keysFile = process.argv[3];
  if (keysFile) {
    const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
    if (enableChangesShortcut(keys)) {
      if (fs.existsSync(keysFile)) fs.copyFileSync(keysFile, `${keysFile}.before-changes`);
      fs.writeFileSync(`${keysFile}.tmp`, JSON.stringify(keys, null, 2) + "\n");
      fs.renameSync(`${keysFile}.tmp`, keysFile);
    }
  }
}

function enableChangesShortcut(keys) {
  const section = keys["layout:orca"] ||= {};
  if (section["cmd-shift-g"] === "orca-tabs.changes") return false;
  // Preserve an explicitly customized Orca shortcut.
  if (section["cmd-shift-g"]) return false;
  section["cmd-shift-g"] = "orca-tabs.changes";
  return true;
}

module.exports = { enableGitPanel, enableChangesShortcut };
