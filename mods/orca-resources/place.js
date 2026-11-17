// Copied from mods/projects/group.js; tested to stay in sync.
export function placeOf(space, panes = []) {
  if (!space) return "";
  const tabs = space.tabs;
  if (Array.isArray(tabs) && tabs.length > 0 && Array.isArray(panes)) {
    const tabIds = new Set(tabs.map((t) => t.id));
    for (const p of panes) {
      if (p && tabIds.has(p.tab) && typeof p.cwd === "string" && p.cwd.length > 0) {
        return p.cwd;
      }
    }
  }
  return space.folder ?? "";
}
