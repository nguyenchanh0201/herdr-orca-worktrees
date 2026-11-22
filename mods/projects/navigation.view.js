import { run, setShared } from "herdr";

// Navigation uses the same visible rows and order as the rendered sidebar.
export function finishNavigation(view, entries, t) {
  view.navigation = entries;
  if (!entries.some(entry => entry.key === view.navKey)) {
    view.navKey = (entries.find(entry => entry.active) || entries[0])?.key ?? null;
    if (view.handle.is_focused() && view.navKey) view.scroll.scroll_to_item(entries.find(entry => entry.key === view.navKey).index);
  }
  for (const entry of entries) {
    if (!entry.node) continue; // Nested rows are decorated before entering their card.
    const selected = view.handle.is_focused() && entry.key === view.navKey;
    entry.node.border(1).border_color(selected ? t.accent : entry.active ? t.border : "#00000000")
      .when(selected, el => el.bg(t.selected))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); selectNavigation(view, entry.key, cx); });
    delete entry.node;
  }
}

export function navigationChild(view, entry, node, t) {
  view.navigation.push(entry);
  return node.border(1).border_color(view.handle.is_focused() && view.navKey === entry.key ? t.accent : "#00000000")
    .when(view.handle.is_focused() && view.navKey === entry.key, el => el.bg(t.selected))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); selectNavigation(view, entry.key, cx); });
}

export function selectNavigation(view, key, cx) {
  const entry = view.navigation.find(item => item.key === key);
  if (!entry) return;
  view.navKey = key;
  view.handle.focus();
  view.scroll.scroll_to_item(entry.index);
  if (entry.agentScroll) entry.agentScroll.scroll_to_item(entry.agentIndex);
  cx.notify();
}

function openNavigation(view, entry, cx) {
  if (entry.activate) entry.activate(cx);
  else if (entry.agent) run("pane.focus", entry.agent.pane ? { pane: entry.agent.pane } : { terminal: entry.agent.address });
  else if (entry.collapseKey) view.toggleCollapsed(entry.collapseKey, cx);
  else if (entry.row) {
    if (entry.row.space) run("space.select", { id: entry.row.space.id });
    if (entry.row.sleeping && entry.worktree) {
      setShared("orca.projects.request", { id: Date.now(), kind: "wake", worktree: entry.worktree });
    }
  }
}

function foldNavigation(view, entry, expand, cx) {
  if (!expand) {
    if (entry.agentsKey && view.agentsOpen.has(entry.agentsKey)) view.toggleAgents(entry.agentsKey, cx);
    else if (entry.collapseKey && !view.collapsed.has(entry.collapseKey)) view.toggleCollapsed(entry.collapseKey, cx);
    else if (entry.parent) selectNavigation(view, entry.parent, cx);
    return;
  }
  if (entry.agentsKey && !view.agentsOpen.has(entry.agentsKey)) { view.toggleAgents(entry.agentsKey, cx); return; }
  const chain = [];
  for (let current = entry; current; current = view.navigation.find(item => item.key === current.parent)) chain.push(current);
  const folded = chain.filter(item => item.collapseKey && view.collapsed.has(item.collapseKey));
  if (folded.length) {
    for (const item of folded) view.collapsed.delete(item.collapseKey);
    view.saveCollapsed();
  } else {
    const child = view.navigation.find(item => item.parent === entry.key);
    if (child) selectNavigation(view, child.key, cx);
  }
}

export function navigationKeyDown(view, e, cx) {
  if (e.modifiers?.platform || e.modifiers?.alt) return;
  const chord = e.keystroke || e.key;
  if (e.modifiers?.control && !["ctrl-d", "ctrl-u"].includes(chord)) return;
  const key = e.key === "g" && (e.modifiers?.shift || e.key_char === "G") ? "G" : e.key;
  if (key === "tab") {
    cx.stop_propagation();
    return;
  }
  if (key === "escape") { run("pane.go", { direction: "right" }); cx.stop_propagation(); return; }
  const entries = view.navigation;
  if (!entries.length) return;
  const index = Math.max(0, entries.findIndex(entry => entry.key === view.navKey));
  const entry = entries[index];
  const count = Number(view.navCount) || 1;
  const move = target => selectNavigation(view, entries[Math.max(0, Math.min(entries.length - 1, target))].key, cx);
  if (/^[1-9]$/.test(key) || (key === "0" && view.navCount)) {
    view.navCount = (view.navCount + key).slice(0, 4);
  } else if (key === "g") {
    if (Date.now() - view.navLastG < 800) { move(view.navCount ? count - 1 : 0); view.navLastG = 0; view.navCount = ""; }
    else view.navLastG = Date.now();
  } else {
    if (["j", "down"].includes(key)) move(index + count);
    else if (["k", "up"].includes(key)) move(index - count);
    else if (["home", "0"].includes(key)) move(0);
    else if (["G", "end"].includes(key)) move(view.navCount ? count - 1 : entries.length - 1);
    else if (["ctrl-d", "ctrl-u"].includes(chord)) move(index + (chord === "ctrl-d" ? 1 : -1) * count * 5);
    else if (["h", "left"].includes(key)) foldNavigation(view, entry, false, cx);
    else if (["l", "right"].includes(key)) foldNavigation(view, entry, true, cx);
    else if (["enter", "return"].includes(key)) openNavigation(view, entry, cx);
    else return;
    view.navCount = "";
    view.navLastG = 0;
  }
  cx.stop_propagation();
  cx.notify();
}
