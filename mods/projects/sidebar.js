export function findNode(tree, id) {
  if (!tree) return null;
  if (tree.id === id) return tree;
  if (Array.isArray(tree.children)) {
    for (const child of tree.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function restoreWidth(saved) {
  const width =
    typeof saved === "number" && Number.isFinite(saved) ? saved : 268;
  return Math.min(500, Math.max(220, width));
}

export function sidebarStep(node, state, saved) {
  if (node == null) {
    return { state, resize: null, hide: false, hiddenChanged: false };
  }

  const hidden = Boolean(node.hidden);
  const hiddenChanged = state.hidden !== null && hidden !== state.hidden;

  let resize = null;
  let hide = false;
  let seenWide = false;

  if (!hidden) {
    if (typeof node.size?.px === "number" && node.size.px < 160) {
      resize = restoreWidth(saved);
      hide = state.seenWide;
    } else {
      seenWide = true;
    }
  }

  return {
    state: { seenWide, hidden: hide ? true : hidden },
    resize,
    hide,
    hiddenChanged,
  };
}
