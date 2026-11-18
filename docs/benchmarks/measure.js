// Usage: node measure.js <seconds> [label]
// Samples both apps' own processes (not the programs inside their terminals) once a second,
// then takes phys_footprint once. Prints JSON.
const { execFileSync } = require("child_process");

const APPS = {
  herdr: (cmd) => cmd.includes("/Herdr.app/") || /herdr-core/.test(cmd),
  orca: (cmd) => cmd.includes("/Orca.app/") || cmd.includes("orca-terminal-host"),
};
// Daemons whose children are terminal shells.
const DAEMON = { herdr: (cmd) => cmd.includes("Herdr Core.app/"), orca: (cmd) => cmd.includes("orca-terminal-host") };

function ps() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return out.trim().split("\n").map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    // ps time is [[dd-]hh:]mm:ss.cc
    const parts = m[4].split(":");
    let secs = parseFloat(parts.pop()); let mult = 60;
    while (parts.length) { secs += parseFloat(parts.pop().replace(/^\d+-/, "")) * mult; mult *= 60; }
    return { pid: +m[1], ppid: +m[2], rss: +m[3], cpu: secs, cmd: m[5] };
  });
}

function classify(procs) {
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const res = {};
  for (const app of Object.keys(APPS)) {
    const own = procs.filter((p) => APPS[app](p.cmd));
    const ownSet = new Set(own.map((p) => p.pid));
    // Terminals: direct children of the daemon(s) that are not app processes; their subtrees are the "inside" programs.
    const shells = own.filter((p) => DAEMON[app](p.cmd)).flatMap((d) => (kids.get(d.pid) ?? []).filter((c) => !ownSet.has(c.pid)));
    const inside = [];
    const walk = (p) => { inside.push(p); for (const c of kids.get(p.pid) ?? []) walk(c); };
    shells.forEach(walk);
    res[app] = { own, terminals: shells.length, inside };
  }
  return res;
}

function footprint(pids) {
  if (!pids.length) return 0;
  try {
    const out = execFileSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = [...out.matchAll(/phys_footprint:\s+([\d.]+)\s+(KB|MB|GB)/g)];
    return m.reduce((s, x) => s + parseFloat(x[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[x[2]], 0);
  } catch { return null; }
}

const secs = +(process.argv[2] || 30);
const label = process.argv[3] || "";
const start = classify(ps());
const rssSamples = { herdr: [], orca: [] };
const t0 = Date.now();
let last = start;
for (let i = 0; i < secs; i++) {
  execFileSync("sleep", ["1"]);
  last = classify(ps());
  for (const app of Object.keys(APPS)) rssSamples[app].push(last[app].own.reduce((s, p) => s + p.rss, 0) / 1024);
}
const elapsed = (Date.now() - t0) / 1000;
const out = { label, seconds: Math.round(elapsed) };
for (const app of Object.keys(APPS)) {
  const cpuOf = (snap) => snap[app].own.reduce((s, p) => s + p.cpu, 0);
  const startPids = new Set(start[app].own.map((p) => p.pid));
  // CPU over the window: only processes alive at both ends.
  const cpu0 = start[app].own.reduce((s, p) => s + p.cpu, 0);
  const cpu1 = last[app].own.filter((p) => startPids.has(p.pid)).reduce((s, p) => s + p.cpu, 0);
  const r = rssSamples[app];
  out[app] = {
    processes: last[app].own.length,
    terminals: last[app].terminals,
    appFootprintMB: +(footprint(last[app].own.map((p) => p.pid)) ?? 0).toFixed(1),
    appRssMB: { avg: +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(1), max: +Math.max(...r).toFixed(1) },
    appCpuPct: +(((cpu1 - cpu0) / elapsed) * 100).toFixed(2),
    insideFootprintMB: +(footprint(last[app].inside.map((p) => p.pid)) ?? 0).toFixed(1),
    insideProcesses: last[app].inside.length,
  };
}
console.log(JSON.stringify(out, null, 1));
