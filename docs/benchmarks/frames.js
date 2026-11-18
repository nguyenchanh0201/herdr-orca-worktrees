// Usage: node frames.js <hitches-frame-lifetimes.xml> [fromSec] [toSec]
// Summarises an Instruments "Animation Hitches" frame-lifetimes export: frames shown per second,
// frame lifetime percentiles and gaps, for the surface (window layer) that showed the most frames.
const fs = require("fs");
const [file, from = "0", to = "1e9"] = process.argv.slice(2);
const xml = fs.readFileSync(file, "utf8");
const ids = new Map();
const val = (tag) => {
  // Each cell is either <tag id="N" fmt="…">value</tag> or <tag ref="N"/>.
  const def = tag.match(/id="(\d+)"[^>]*>([^<]*)</);
  if (def) { ids.set(def[1], def[2]); return def[2]; }
  const ref = tag.match(/ref="(\d+)"/);
  return ref ? ids.get(ref[1]) : null;
};
const all = [];
for (const row of xml.match(/<row>[\s\S]*?<\/row>/g) ?? []) {
  const cells = row.match(/<(start-time|duration|event-concept|uint32)[^>]*?(?:\/>|>[^<]*<\/\1>)/g) ?? [];
  const get = (name) => { const c = cells.find((x) => x.startsWith(`<${name}`)); return c ? val(c) : null; };
  const u = cells.filter((x) => x.startsWith("<uint32")).map(val); // [swap-id, surface-id]
  const start = +get("start-time") / 1e9, dur = +get("duration") / 1e6, surface = u[1];
  if (start >= +from && start <= +to) all.push({ start, dur, surface });
}
const counts = {};
for (const f of all) counts[f.surface] = (counts[f.surface] ?? 0) + 1;
const main = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
const frames = all.filter((f) => f.surface === main);
frames.sort((a, b) => a.start - b.start);
const d = frames.map((f) => f.dur).sort((a, b) => a - b);
const pct = (p) => d.length ? +d[Math.min(d.length - 1, Math.floor((p / 100) * d.length))].toFixed(1) : null;
const span = frames.length > 1 ? frames.at(-1).start - frames[0].start : 0;
// Gaps between frames: a gap over 50 ms is a visible stutter while content is changing.
let stutters = 0, maxGap = 0;
for (let i = 1; i < frames.length; i++) { const g = (frames[i].start - frames[i - 1].start) * 1000; if (g > 50) stutters++; maxGap = Math.max(maxGap, g); }
console.log(JSON.stringify({
  frames: frames.length,
  fps: span ? +(frames.length / span).toFixed(1) : 0,
  lifetimeMs: { p50: pct(50), p95: pct(95), max: d.length ? +d.at(-1).toFixed(1) : null },
  surfaces: counts,
  gapsOver50ms: stutters,
  maxGapMs: +maxGap.toFixed(1),
}));
