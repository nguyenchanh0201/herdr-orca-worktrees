const CANONICAL_ORDER = ["claude", "codex", "agy"];

export function merge(prev = [], next = [], skipped = []) {
  const skipSet = new Set(skipped);
  const prevMap = new Map(prev.map((p) => [p.id, p]));
  const nextMap = new Map(next.map((p) => [p.id, p]));
  const merged = new Map();

  for (const [id, p] of prevMap) {
    merged.set(id, p);
  }

  for (const [id, n] of nextMap) {
    if (skipSet.has(id) && prevMap.has(id)) continue;
    const p = prevMap.get(id);
    if (n.status === "error") {
      const windows = p?.windows?.length ? p.windows : n.windows ?? [];
      merged.set(id, { ...n, windows });
    } else if (n.status === "unavailable") {
      merged.set(id, { ...n, windows: [] });
    } else {
      merged.set(id, n);
    }
  }

  const out = [];
  for (const id of CANONICAL_ORDER) {
    if (merged.has(id)) {
      out.push(merged.get(id));
      merged.delete(id);
    }
  }
  for (const entry of merged.values()) {
    out.push(entry);
  }
  return out;
}
