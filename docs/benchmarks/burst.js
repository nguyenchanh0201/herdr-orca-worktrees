// Usage: node burst.js <herdr|orca> <terminal> [lines=3000000] [runs=3]
// Prints `seq 1 <lines>` into a visible terminal of that app and measures the CPU time the
// app's own processes spend (window + terminal service), and the wall time until seq ends.
const { execFileSync } = require("child_process");
const fs = require("fs");

const [app, term, lines = "3000000", runs = "3"] = process.argv.slice(2);
const ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca";
const OWN = {
  herdr: (cmd) => cmd.includes("/Herdr.app/") || /herdr-core/.test(cmd),
  orca: (cmd) => cmd.includes("/Orca.app/") || cmd.includes("orca-terminal-host"),
}[app];

const names = new Map();
const perProc = new Map();
function cpuSeconds() {
  const out = execFileSync("ps", ["-axo", "pid=,time=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const by = new Map();
  for (const l of out.trim().split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m || !OWN(m[3])) continue;
    const parts = m[2].split(":");
    let s = parseFloat(parts.pop()), mult = 60;
    while (parts.length) { s += parseFloat(parts.pop().replace(/^\d+-/, "")) * mult; mult *= 60; }
    by.set(+m[1], s);
    names.set(+m[1], m[3].replace(/^.*\/(?=[^/]*$)/, "").slice(0, 40));
  }
  return by;
}
const sum = (a, b) => [...b].reduce((s, [pid, t]) => s + (a.has(pid) ? t - a.get(pid) : 0), 0);
const sleep = (s) => execFileSync("sleep", [String(s)]);

function send(text) {
  if (app === "herdr") execFileSync("hc", ["send", term, text]);
  else execFileSync(ORCA, ["terminal", "send", "--terminal", term, "--text", text, "--enter", "--json"]);
}

const results = [];
for (let i = 0; i < +runs; i++) {
  const done = `/tmp/burst-${app}-${process.pid}-${i}`;
  try { fs.unlinkSync(done); } catch {}
  send("clear");
  sleep(3);
  const before = cpuSeconds();
  const t0 = Date.now();
  send(`seq 1 ${lines}; perl -MTime::HiRes=time -e 'print time' > ${done}`);
  while (!fs.existsSync(done) || !fs.readFileSync(done, "utf8")) sleep(0.2);
  const wall = parseFloat(fs.readFileSync(done, "utf8")) - t0 / 1000;
  sleep(3); // let the last frames draw
  const after = cpuSeconds();
  const cpu = sum(before, after);
  for (const [pid, t] of after) if (before.has(pid)) { const k = names.get(pid); perProc.set(k, (perProc.get(k) ?? 0) + (t - before.get(pid))); }
  results.push({ run: i + 1, wallSeconds: +wall.toFixed(2), appCpuSeconds: +cpu.toFixed(2) });
  try { fs.unlinkSync(done); } catch {}
}
const avg = (k) => +(results.reduce((s, r) => s + r[k], 0) / results.length).toFixed(2);
const byProcess = Object.fromEntries([...perProc].filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / results.length).toFixed(2)]));
console.log(JSON.stringify({ app, lines: +lines, results, byProcessAvg: byProcess, avgWallSeconds: avg("wallSeconds"), avgAppCpuSeconds: avg("appCpuSeconds") }, null, 1));
