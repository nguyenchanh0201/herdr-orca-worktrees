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

export function barColor(pct) {
  if (pct >= 90) return "ansi1";
  if (pct >= 80) return "ansi3";
  return "ansi2";
}
