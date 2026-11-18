const test = require('node:test');
const assert = require('node:assert/strict');

const PS = " 10   1  0.5  1000\n 11  10  1.0  2000\n 12  11  0.0  3000\n 20   1  2.0  4000\n\n";

test("parsePs tolerates spacing and blank lines", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const p = t.parsePs(PS);
  assert.equal(p.size, 4);
  assert.deepEqual(p.get(12), { ppid: 11, cpu: 0, rss: 3000 });
});

test("parseProcessSnapshot keeps the full command paired with its process", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const snapshot = t.parseProcessSnapshot([
    '   5  1  1.5  100   /Applications/Herdr Core.app/Contents/MacOS/herdr-core  ',
    ' 6 5 0.0 50 /bin/zsh',
    'not a process',
    '7 6 bad 999 /bin/sh',
    '8 6 1.0 999',
    '9x 6 1.0 999 /bin/sh',
  ].join('\r\n'));
  assert.deepEqual([...snapshot.procs], [
    [5, { ppid: 1, cpu: 1.5, rss: 100 }],
    [6, { ppid: 5, cpu: 0, rss: 50 }],
  ]);
  assert.deepEqual([...snapshot.commands], [
    [5, '/Applications/Herdr Core.app/Contents/MacOS/herdr-core'],
    [6, '/bin/zsh'],
  ]);
});

test("parseProcessSnapshot returns null without a usable process row", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  assert.equal(t.parseProcessSnapshot('PID PPID %CPU RSS COMM\n1 0 0.0 10\n'), null);
  assert.equal(t.parseProcessSnapshot(''), null);
});

test("subtreeTotals sums descendants and counts each pid once", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const tot = t.subtreeTotals(t.parsePs(PS), [10, 11, 99]);
  assert.deepEqual(tot.get(10), { cpu: 1.5, rss: 6000, pids: [10, 11, 12] });
  assert.deepEqual(tot.get(11), { cpu: 0, rss: 0, pids: [] });
  assert.deepEqual(tot.get(99), { cpu: 0, rss: 0, pids: [] });
});

test("herdrTotals stops at terminal shells", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const procs = t.parsePs(" 5 1 1.0 100\n 6 5 0.0 50\n 7 6 3.0 999\n");
  const cmds = new Map([
    [5, "/Applications/Herdr.app/Contents/MacOS/Herdr"],
    [6, "/x/herdr-core"],
    [7, "/bin/zsh"],
  ]);
  assert.deepEqual(t.herdrTotals(procs, cmds, new Set([7])), { cpu: 1, rss: 150 });
});

test("fmtMem and fmtCpu", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  assert.equal(t.fmtMem(738099), "720.8 MB");
  assert.equal(t.fmtMem(1121976), "1.07 GB");
  assert.equal(t.fmtCpu(2.44), "2.4%");
});

test("pushHistory keeps 60 points and drops stale keys", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const h = new Map();
  for (let i = 0; i < 70; i++) t.pushHistory(h, "a", i, i);
  assert.equal(h.get("a").points.length, 60);
  assert.equal(h.get("a").points[0], 10);
  t.pushHistory(h, "b", 1, 700000);
  assert.equal(h.has("a"), false);
});

test("isAgent", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  assert.deepEqual(
    ["zsh", "bash", "fish", "sh", "claude-code", "codex"].map(t.isAgent),
    [false, false, false, false, true, true],
  );
});

test("buildSnapshot groups projects and worktrees, counts Herdr terminals, and includes herdr rss", async () => {
  const t = await import('../mods/orca-resources/tree.js');
  const terminals = [
    { address: "t1", pid: 10, space: { id: "s1", name: "wt-a", folder: "/repos/alpha/wt-a" }, label: "tab 1", agent: "claude-code", folder: "/repos/alpha/wt-a" },
    { address: "t2", pid: 20, space: { id: "s1", name: "wt-a", folder: "/repos/alpha/wt-a" }, label: "tab 2", agent: "zsh", folder: "/repos/alpha/wt-a" },
    { address: "t3", pid: 30, space: { id: "s2", name: "wt-b", folder: "/repos/beta/wt-b" }, label: "tab 3", agent: "codex", folder: "/repos/beta/wt-b" },
    { address: "t4", pid: 40, space: null, label: "other", agent: "bash", folder: "/tmp" },
  ];
  const totals = new Map([
    [10, { cpu: 1.5, rss: 1000, pids: [10] }],
    [20, { cpu: 2.0, rss: 2000, pids: [20] }],
    [30, { cpu: 0.5, rss: 500, pids: [30] }],
    [40, { cpu: 0.2, rss: 200, pids: [40] }],
  ]);
  const herdr = { cpu: 1.0, rss: 300 };
  const placeOf = (s) => s.folder;
  const repoOf = (place) => {
    if (place.includes("/alpha/")) return { key: "/repos/alpha", name: "alpha" };
    if (place.includes("/beta/")) return { key: "/repos/beta", name: "beta" };
    return { key: place, name: place };
  };

  const snap = t.buildSnapshot({ terminals, totals, herdr, placeOf, repoOf, now: 12345 });
  assert.equal(snap.at, 12345);
  assert.equal(snap.count, 3);
  assert.equal(snap.rss, 4000);
  assert.ok(Math.abs(snap.cpu - 5.2) < 1e-9);
  assert.deepEqual(snap.herdr, { cpu: 1.0, rss: 300 });
  assert.equal(snap.other.length, 1);
  assert.equal(snap.other[0].address, "t4");
  assert.equal(snap.projects.length, 2);
  const alpha = snap.projects.find((p) => p.key === "/repos/alpha");
  assert.equal(alpha.name, "alpha");
  assert.equal(alpha.rss, 3000);
  assert.ok(Math.abs(alpha.cpu - 3.5) < 1e-9);
  assert.equal(alpha.worktrees.length, 1);
  assert.equal(alpha.worktrees[0].key, "/repos/alpha/wt-a");
  assert.equal(alpha.worktrees[0].name, "wt-a");
  assert.equal(alpha.worktrees[0].terminals.length, 2);
});
