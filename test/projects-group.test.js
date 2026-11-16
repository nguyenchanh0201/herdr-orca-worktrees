const test = require("node:test");
const assert = require("node:assert/strict");

let g;

test.before(async () => {
  g = await import("../mods/projects/group.js");
});

function sp(id, {
  folder = "/" + id,
  machine = null,
  branch = null,
  named = false,
  name = id,
  active = false,
  tabs = [],
} = {}) {
  return { id, folder, machine, branch, named, name, active, tabs };
}

test("placeOf uses first pane cwd of its tabs", () => {
  const space = sp("s1", { folder: "/fallback", tabs: [{ id: "t1" }] });
  const panes = [
    { tab: "x", cwd: "/a" },
    { tab: "t1", cwd: "/r/sub" },
  ];
  assert.equal(g.placeOf(space, panes), "/r/sub");
  assert.equal(g.placeOf(space, [{ tab: "other", cwd: "/b" }]), "/fallback");
  assert.equal(g.placeOf(space, []), "/fallback");
});

test("groups main and worktrees", () => {
  const w1 = sp("w1", { folder: "/wt/a" });
  const m = sp("m", { folder: "/r" });
  const w2 = sp("w2", { folder: "/wt/b" });
  const repoMap = {
    "/r": { primary: "/r", linked: false },
    "/wt/a": { primary: "/r", linked: true },
    "/wt/b": { primary: "/r", linked: true },
  };

  const groups = g.group([w1, m, w2], (s) => s.folder, (p) => repoMap[p]);
  assert.equal(groups.length, 1);
  const grp = groups[0];
  assert.equal(grp.key, "/r");
  assert.equal(grp.name, "r");
  assert.equal(grp.kind, "repo");
  assert.equal(grp.primary, "/r");
  assert.equal(grp.primarySpace, "m");
  assert.deepEqual(grp.rows.map((r) => r.space.id), ["m", "w1", "w2"]);
  assert.equal(grp.rows[0].main, true);
  assert.equal(grp.rows[1].main, false);
  assert.equal(grp.rows[2].main, false);
});

test("header without main space", () => {
  const w1 = sp("w1", { folder: "/wt/a" });
  const w2 = sp("w2", { folder: "/wt/b" });
  const repoMap = {
    "/wt/a": { primary: "/r", linked: true },
    "/wt/b": { primary: "/r", linked: true },
  };

  const groups = g.group([w1, w2], (s) => s.folder, (p) => repoMap[p]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primarySpace, null);
  assert.equal(groups[0].primary, "/r");
  assert.equal(groups[0].name, "r");
  assert.deepEqual(groups[0].rows.map((r) => r.space.id), ["w1", "w2"]);
});

test("non-git goes to Other last", () => {
  const h = sp("h", { folder: "/home" });
  const r = sp("r", { folder: "/r" });
  const repoMap = {
    "/home": null,
    "/r": { primary: "/r", linked: false },
  };

  const groups = g.group([h, r], (s) => s.folder, (p) => repoMap[p]);
  assert.deepEqual(groups.map((grp) => grp.key), ["/r", "other"]);
  const other = groups[1];
  assert.equal(other.name, "Other");
  assert.equal(other.kind, "other");
  assert.equal(other.primary, null);
  assert.equal(other.primarySpace, null);
  assert.deepEqual(other.rows.map((row) => row.space.id), ["h"]);
  assert.equal(other.rows[0].main, false);
});

test("remote grouped by machine", () => {
  const vps = sp("v1", { folder: "/remote/path", machine: "vps" });
  const groups = g.group([vps], (s) => s.folder, () => {
    throw new Error("repoOf should never be called for remote space");
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    key: "machine:vps",
    name: "vps",
    kind: "machine",
    primary: null,
    primarySpace: null,
    rows: [{ space: vps, main: false }],
  });
});

test("group order follows spaces()", () => {
  const b = sp("b", { folder: "/b" });
  const a = sp("a", { folder: "/a" });
  const repoMap = {
    "/b": { primary: "/b", linked: false },
    "/a": { primary: "/a", linked: false },
  };

  const groups = g.group([b, a], (s) => s.folder, (p) => repoMap[p]);
  assert.deepEqual(groups.map((grp) => grp.key), ["/b", "/a"]);
});

test("unknown held, then prev group, then Other", () => {
  const unk = sp("u", { folder: "/unknown" });
  const r = sp("r", { folder: "/r" });
  const repoMap = {
    "/r": { primary: "/r", linked: false },
    "/unknown": undefined,
  };

  // Case 1: prevKeyOf -> undefined, giveUp -> false => absent from every group
  const g1 = g.group([unk], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: () => undefined,
    giveUp: () => false,
  });
  assert.deepEqual(g1, []);

  // Case 2: prevKeyOf -> "/r" (and /r group present via another space) => in /r
  const g2 = g.group([r, unk], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: (id) => (id === "u" ? "/r" : undefined),
    giveUp: () => false,
  });
  assert.equal(g2.length, 1);
  assert.equal(g2[0].key, "/r");
  assert.deepEqual(g2[0].rows.map((row) => row.space.id), ["r", "u"]);

  // Case 3: giveUp -> true => in other
  const g3 = g.group([unk], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: () => undefined,
    giveUp: () => true,
  });
  assert.equal(g3.length, 1);
  assert.equal(g3[0].key, "other");
  assert.deepEqual(g3[0].rows.map((row) => row.space.id), ["u"]);
});

test("moves when place changes", () => {
  const s = sp("s", { folder: "/r" });
  const repoMap = {
    "/r": { primary: "/r", linked: false },
    "/s": { primary: "/s", linked: false },
  };

  // First call with place /r
  const g1 = g.group([s], () => "/r", (p) => repoMap[p]);
  assert.equal(g1.length, 1);
  assert.equal(g1[0].key, "/r");
  assert.deepEqual(g1[0].rows.map((row) => row.space.id), ["s"]);

  // Second call with place /s
  const g2 = g.group([s], () => "/s", (p) => repoMap[p]);
  assert.equal(g2.length, 1);
  assert.equal(g2[0].key, "/s");
  assert.deepEqual(g2[0].rows.map((row) => row.space.id), ["s"]);
});

test("visibleRows keeps active in collapsed group", () => {
  const rowA = { space: sp("a", { active: true }), main: false };
  const rowB = { space: sp("b", { active: false }), main: false };
  const group = {
    key: "/r",
    name: "r",
    kind: "repo",
    primary: "/r",
    primarySpace: null,
    rows: [rowA, rowB],
  };

  const collapsedRows = g.visibleRows(group, true);
  assert.deepEqual(collapsedRows.map((r) => r.space.id), ["a"]);

  const expandedRows = g.visibleRows(group, false);
  assert.deepEqual(expandedRows.map((r) => r.space.id), ["a", "b"]);
});

test("label", () => {
  assert.equal(g.label({ named: true, name: "fix", branch: "b" }), "fix");
  assert.equal(g.label({ named: false, name: "r", branch: "feat/x" }), "feat/x");
  assert.equal(g.label({ named: false, name: "~", branch: null }), "~");
});

test("unknown space with prevKeyOf pointing to a group that appears later in spaces", () => {
  const u = sp("u", { folder: "/unknown" });
  const a = sp("a", { folder: "/a" });
  const b = sp("b", { folder: "/b" });
  const repoMap = {
    "/unknown": undefined,
    "/a": { primary: "/a", linked: false },
    "/b": { primary: "/b", linked: false },
  };
  // u is at index 0, prevKeyOf points to "/b" which is defined by space b at index 2
  const groups = g.group([u, a, b], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: (id) => (id === "u" ? "/b" : undefined),
    giveUp: () => false,
  });
  // Group order should have /b first (because u is at index 0 and in /b), then /a
  assert.deepEqual(groups.map((grp) => grp.key), ["/b", "/a"]);
  const bGroup = groups[0];
  assert.equal(bGroup.primarySpace, "b");
  // main space b should come before u
  assert.deepEqual(bGroup.rows.map((r) => r.space.id), ["b", "u"]);
  assert.equal(bGroup.rows[0].main, true);
  assert.equal(bGroup.rows[1].main, false);
});

test("unknown space with prevKeyOf pointing to nonexistent group", () => {
  const u = sp("u", { folder: "/unknown" });
  const a = sp("a", { folder: "/a" });
  const repoMap = {
    "/unknown": undefined,
    "/a": { primary: "/a", linked: false },
  };
  // prevKeyOf points to "/nonexistent", giveUp is false => omitted
  const g1 = g.group([u, a], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: () => "/nonexistent",
    giveUp: () => false,
  });
  assert.deepEqual(g1.map((grp) => grp.key), ["/a"]);

  // prevKeyOf points to "/nonexistent", giveUp is true => goes to Other
  const g2 = g.group([u, a], (s) => s.folder, (p) => repoMap[p], {
    prevKeyOf: () => "/nonexistent",
    giveUp: () => true,
  });
  assert.deepEqual(g2.map((grp) => grp.key), ["/a", "other"]);
  const other = g2[1];
  assert.deepEqual(other.rows.map((r) => r.space.id), ["u"]);
});

test("repo name handles trailing slashes", () => {
  const s = sp("s", { folder: "/path/to/my-repo/" });
  const groups = g.group([s], (s) => s.folder, () => ({ primary: "/path/to/my-repo/", linked: false }));
  assert.equal(groups[0].name, "my-repo");
  assert.equal(groups[0].primary, "/path/to/my-repo/");
});

test("agentsBySpace groups by space in order", () => {
  const m = g.agentsBySpace([
    { address: "a", space: "s1" },
    { address: "b", space: "s2" },
    { address: "c", space: "s1" },
  ]);
  assert.deepEqual(m.get("s1").map((x) => x.address), ["a", "c"]);
  assert.deepEqual(m.get("s2").map((x) => x.address), ["b"]);
  assert.equal(m.get("s3"), undefined);
});

test("sinceUpdate keeps time while status same", () => {
  const prev = new Map([["a", { status: "idle", at: 100 }]]);
  const res = g.sinceUpdate(prev, [{ address: "a", status: "idle" }], 500);
  assert.deepEqual(res.get("a"), { status: "idle", at: 100 });
});

test("sinceUpdate resets on status change", () => {
  const prev = new Map([["a", { status: "idle", at: 100 }]]);
  const res = g.sinceUpdate(prev, [{ address: "a", status: "working" }], 500);
  assert.deepEqual(res.get("a"), { status: "working", at: 500 });
});

test("sinceUpdate starts new agents at now", () => {
  const res = g.sinceUpdate(new Map(), [{ address: "b", status: "idle" }], 500);
  assert.deepEqual(res.get("b"), { status: "idle", at: 500 });
});

test("sinceUpdate drops gone agents", () => {
  const prev = new Map([["a", { status: "idle", at: 100 }]]);
  const res = g.sinceUpdate(prev, [], 500);
  assert.equal(res.size, 0);
});

test("elapsed", () => {
  assert.equal(g.elapsed(-100), "");
  assert.equal(g.elapsed(59_999), "");
  assert.equal(g.elapsed(60_000), "1m");
  assert.equal(g.elapsed(3_599_999), "59m");
  assert.equal(g.elapsed(3_600_000), "1h");
  assert.equal(g.elapsed(7_300_000), "2h");
});
