const fs = require("node:fs");
const path = require("node:path");

// Upgrade the saved Orca layout without replacing its custom panes or sizing.
function enableGitPanel(layout, { agents = false, gitview = false } = {}) {
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
  const agentPanel = find(layout, "agents");
  if (agents && agentPanel?.content?.mod === "agents") {
    agentPanel.content = { ...agentPanel.content, mod: "orca-agents" };
    changed = true;
  }
  const changes = body.children.find(child => child.id === "changes");
  const git = body.children.find(child => child.id === "git" && child.content?.mod === "orca-commits");
  if (!changes) {
    body.children.push({ ...(git || { type: "block" }), id: "changes", content: { mod: "orca-commits" } });
    changed = true;
  } else if (changes.content?.mod === "changes") {
    changes.content = { ...changes.content, mod: "orca-commits" };
    changed = true;
  }
  const slot = body.children.find(child => child.id === "changes");
  if (gitview && ["changes", "orca-commits"].includes(slot?.content?.mod)) {
    slot.content = {mod: "gitview", props: {replaces: slot.content}};
    changed = true;
  }
  if (["orca-commits", "gitview"].includes(slot?.content?.mod) && git) {
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
  const agentsInstalled = fs.existsSync(path.join(path.dirname(file), "..", "mods", "orca-agents", "mod.json"));
  const gitviewInstalled = fs.existsSync(path.join(path.dirname(file), "..", "mods", "gitview", "config.json"));
  if (enableGitPanel(layout, { agents: agentsInstalled, gitview: gitviewInstalled })) {
    fs.copyFileSync(file, `${file}.before-git`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(layout, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
    console.log("updated Orca panels and navigation (backup: orca.json.before-git)");
  }
  const keysFile = process.argv[3];
  if (keysFile) {
    const keys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
    const gitview = usesGitview(layout);
    if (enableChangesShortcut(keys, { gitview })) {
      if (fs.existsSync(keysFile)) fs.copyFileSync(keysFile, `${keysFile}.before-changes`);
      fs.writeFileSync(`${keysFile}.tmp`, JSON.stringify(keys, null, 2) + "\n");
      fs.renameSync(`${keysFile}.tmp`, keysFile);
    }
  }
}

function usesGitview(node) {
  if (node?.id === "changes" && node.content?.mod === "gitview") return true;
  return (node?.children || []).some(usesGitview);
}

function enableChangesShortcut(keys, { gitview = false } = {}) {
  const section = keys["layout:orca"] ||= {};
  let changed = false;
  // Preserve an explicitly customized Orca shortcut.
  const changesCommand = gitview ? "mod.open:gitview-sidebar" : "orca-tabs.changes";
  if (gitview && !section["cmd-g"]) {
    section["cmd-g"] = "mod.open:gitview-tab";
    changed = true;
  }
  if (!section["cmd-shift-g"] || (["orca-tabs.changes", "mod.open:gitview-sidebar"].includes(section["cmd-shift-g"]) && section["cmd-shift-g"] !== changesCommand)) {
    section["cmd-shift-g"] = changesCommand;
    changed = true;
  }
  for (const [key, command] of [["cmd-shift-h", "pane.go:left"], ["cmd-shift-j", "pane.go:down"], ["cmd-shift-k", "pane.go:up"], ["cmd-shift-l", "pane.go:right"]]) {
    if (section[key] === command) continue;
    section[key] = command;
    changed = true;
  }
  const panel = keys["mod:orca-commits"] ||= {};
  if (panel["cmd-k"] === "orca-commits.history") {
    delete panel["cmd-k"];
    changed = true;
  }
  for (const [key, command] of [["cmd-h", "orca-commits.changes"], ["cmd-l", "orca-commits.history"], ["cmd-shift-h", "orca-commits.back"], ["cmd-shift-l", "orca-commits.forward"]]) {
    if (panel[key] === command) continue;
    panel[key] = command;
    changed = true;
  }
  return changed;
}

module.exports = { enableGitPanel, enableChangesShortcut };
