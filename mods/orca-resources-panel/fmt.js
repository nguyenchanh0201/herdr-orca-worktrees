// Copied from mods/orca-resources/tree.js; tested to stay in sync.
const KB_PER_GB = 1048576;

export function fmtMem(kb) {
  const n = Number.isFinite(kb) ? kb : 0;
  if (n < KB_PER_GB) return `${(n / 1024).toFixed(1)} MB`;
  return `${(n / KB_PER_GB).toFixed(2)} GB`;
}

export function fmtCpu(n) {
  return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
}
