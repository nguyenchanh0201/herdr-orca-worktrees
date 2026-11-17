export function until(resetsAt, now = Date.now()) {
  if (resetsAt == null) return "";
  if (resetsAt <= now) return "now";
  const diff = resetsAt - now;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
  }
  return `${Math.floor(diff / 86_400_000)}d ${Math.floor((diff % 86_400_000) / 3_600_000)}h`;
}

export function headline(p, now = Date.now()) {
  if (!p || (!p.status && !p.fetchedAt && (!p.windows || p.windows.length === 0))) {
    return "···";
  }
  if (!p.windows || p.windows.length === 0) {
    return p.status === "ok" ? "--" : "";
  }
  let w = p.windows[0];
  for (let i = 1; i < p.windows.length; i++) {
    if (p.windows[i].usedPercent > w.usedPercent) w = p.windows[i];
  }
  const pct = Math.round(w.usedPercent);
  if (w.minutes > 0) return `${pct}% ${until(w.resetsAt, now) || w.label}`;
  return `${w.label} ${pct}%`;
}

export function shortGroup(label) {
  return label.split(" · ")[0].replace(/ Models$/, "");
}

export function chipText(p, mode = "compact", now = Date.now()) {
  if (!p || (!p.status && !p.fetchedAt && (!p.windows || p.windows.length === 0))) {
    return "···";
  }
  if (!p.windows || p.windows.length === 0) {
    return p.status === "ok" ? "--" : "";
  }
  if (mode === "detailed") {
    return p.windows
      .map((w) => {
        const fallback = w.label.includes(" · ")
          ? (shortGroup(w.label) + (w.minutes === 10080 ? " wk" : w.minutes === 300 ? " 5h" : "")).trim()
          : w.label;
        return `${Math.round(w.usedPercent)}% ${until(w.resetsAt, now) || fallback}`;
      })
      .join(" · ");
  }
  let w = p.windows[0];
  for (let i = 1; i < p.windows.length; i++) {
    if (p.windows[i].usedPercent > w.usedPercent) w = p.windows[i];
  }
  const pct = Math.round(w.usedPercent);
  if (w.label.includes(" · ")) {
    const suffix = w.minutes === 10080 ? "wk" : w.minutes === 300 ? "5h" : "";
    return `${pct}% ${shortGroup(w.label)} ${suffix}`.trim();
  }
  return headline(p, now);
}

export function windowName(w) {
  if (w.label === "Fable") return "Fable";
  if (w.minutes === 300) return "Session";
  if (w.minutes === 10080) return "Weekly";
  return w.label;
}

export function updatedText(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return "Not updated yet";
  const diff = Math.max(0, now - fetchedAt);
  if (diff < 60_000) return "Updated just now";
  if (diff < 3_600_000) return `Updated ${Math.floor(diff / 60_000)}m ago`;
  return `Updated ${Math.floor(diff / 3_600_000)}h ago`;
}

export function barColor(pct) {
  if (pct >= 80) return "ansi1";
  if (pct >= 60) return "ansi3";
  return "muted";
}

export function windowShort(w) {
  if (w.label === "Fable") return "Fable";
  if (w.minutes === 300) return "5h";
  if (w.minutes === 10080) return "wk";
  return w.label;
}

// Antigravity labels are long, so each window gets its own line.
export function detailLines(p) {
  const items = (p.windows ?? []).map((w) => ({
    label: p.id === "agy" ? w.label : windowShort(w),
    pct: Math.max(0, Math.min(100, Math.round(w.usedPercent))),
  }));
  if (items.length === 0) return [];
  return p.id === "agy" ? items.map((i) => [i]) : [items];
}
