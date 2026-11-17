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

test("letterOf", () => {
  const { letterOf } = g;
  assert.equal(letterOf("Coduct.CTM.AdminPortal"), "A");
  assert.equal(letterOf("Coduct.CTM.UserApp"), "U");
  assert.equal(letterOf("herdr-orca-worktrees"), "H");
  assert.equal(letterOf("x."), "X");
  assert.equal(letterOf(""), "?");
  assert.equal(letterOf("app.123"), "1");
  assert.equal(letterOf("app.-server"), "S");
  assert.equal(letterOf("app.---"), "A");
});

test("colorIndex is stable and in range", () => {
  const { colorIndex } = g;
  const a = colorIndex("/a/Coduct.CTM.Server", 8);
  assert.equal(a, colorIndex("/a/Coduct.CTM.Server", 8));
  assert.ok(a >= 0 && a < 8);
});

test("stripLogin", () => {
  const { stripLogin } = g;
  const L = ["jimmy-nguyen-codeleap", "nguyenchanh0201"];
  assert.equal(stripLogin("nguyenchanh0201/feat-CTMN-197-add-comments", L), "feat-CTMN-197-add-comments");
  assert.equal(stripLogin("NguyenChanh0201/x", L), "x");
  assert.equal(stripLogin("feat/CTMN-199/manage", L), "feat/CTMN-199/manage");
  assert.equal(stripLogin("feat/nguyenchanh0201/x", L), "feat/nguyenchanh0201/x");
  assert.equal(stripLogin("nguyenchanh0201", L), "nguyenchanh0201");
  assert.equal(stripLogin("nguyenchanh0201/", L), "nguyenchanh0201/");
});

test("label strips login from branch, not from a set name", () => {
  const { label } = g;
  const L = ["nguyenchanh0201"];
  assert.equal(label({ branch: "nguyenchanh0201/explore", name: "x", named: false }, L), "explore");
  assert.equal(label({ branch: "nguyenchanh0201/explore", name: "Mine", named: true }, L), "Mine");
  assert.equal(label({ space: null, sleeping: { branch: "nguyenchanh0201/a" }, worktree: "/w/a" }, L), "a");
  assert.equal(label({ space: sp("s", { branch: "nguyenchanh0201/explore" }) }, L), "explore");
  assert.equal(label({ space: sp("s", { name: "nguyenchanh0201/Mine", named: true }) }, L), "nguyenchanh0201/Mine");
  assert.equal(label({ name: "nguyenchanh0201/fallback", branch: null }, L), "nguyenchanh0201/fallback");
});

test("group carries saved name and icon", () => {
  const spaces = [sp("admin", { folder: "/admin" }), sp("unsaved", { folder: "/unsaved" })];
  const repoMap = {
    "/admin": { primary: "/admin", linked: false },
    "/unsaved": { primary: "/unsaved", linked: false },
  };
  const groups = g.group(spaces, (s) => s.folder, (p) => repoMap[p], {
    saved: [
      { path: "/admin", exists: true, name: "Admin", icon: "data/project-icons/x.png", iconSource: { source: "custom" } },
      { path: "/saved-only", exists: false, name: "Saved", icon: "data/project-icons/y.png", iconSource: { source: "custom" } },
      { path: "/nullable", exists: true, name: null, icon: null, iconSource: null },
    ],
  });
  const [admin, unsaved, savedOnly, nullable] = groups;
  assert.equal(admin.displayName, "Admin");
  assert.equal(admin.icon, "data/project-icons/x.png");
  assert.equal(admin.name, "admin");
  assert.equal(admin.saved, true);
  assert.equal(admin.exists, true);
  assert.equal(unsaved.displayName, unsaved.name);
  assert.equal(unsaved.icon, null);
  assert.equal(savedOnly.displayName, "Saved");
  assert.equal(savedOnly.icon, "data/project-icons/y.png");
  assert.equal(savedOnly.exists, false);
  assert.equal(nullable.displayName, "nullable");
  assert.equal(nullable.icon, null);
});

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

test("saved-only group after space groups", () => {
  const r = sp("r", { folder: "/r" });
  const repoMap = { "/r": { primary: "/r", linked: false } };
  const groups = g.group([r], (s) => s.folder, (p) => repoMap[p], {
    saved: [{ path: "/s", exists: true }],
  });
  assert.deepEqual(groups.map((grp) => grp.key), ["/r", "/s"]);
  assert.deepEqual(groups[1], {
    key: "/s",
    name: "s",
    displayName: "s",
    icon: null,
    group: null,
    kind: "repo",
    primary: "/s",
    primarySpace: null,
    rows: [],
    saved: true,
    exists: true,
  });
});

test("saved before Other", () => {
  const r = sp("r", { folder: "/r" });
  const h = sp("h", { folder: "/home" });
  const repoMap = {
    "/r": { primary: "/r", linked: false },
    "/home": null,
  };
  const groups = g.group([r, h], (s) => s.folder, (p) => repoMap[p], {
    saved: [{ path: "/s", exists: true }],
  });
  assert.deepEqual(groups.map((grp) => grp.key), ["/r", "/s", "other"]);
});

test("saved with spaces not duplicated", () => {
  const r = sp("r", { folder: "/r" });
  const repoMap = { "/r": { primary: "/r", linked: false } };
  const groups = g.group([r], (s) => s.folder, (p) => repoMap[p], {
    saved: [{ path: "/r", exists: true }],
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "/r");
  assert.equal(groups[0].saved, true);
  assert.equal(groups[0].exists, true);
  assert.equal(groups[0].rows.length, 1);
});

test("missing saved keeps header", () => {
  const groups = g.group([], (s) => s.folder, () => null, {
    saved: [{ path: "/gone", exists: false }],
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    key: "/gone",
    name: "gone",
    displayName: "gone",
    icon: null,
    group: null,
    kind: "repo",
    primary: "/gone",
    primarySpace: null,
    rows: [],
    saved: true,
    exists: false,
  });
});

test("activitySort orders by status priority then newest since timestamp", () => {
  const agents = [
    { address: "i1", status: "idle" },
    { address: "w1", status: "working" },
    { address: "d1", status: "done" },
    { address: "b1", status: "blocked" },
    { address: "b2", status: "blocked" },
    { address: "u1", status: "unknown" },
  ];
  const since = new Map([
    ["b1", { status: "blocked", at: 100 }],
    ["b2", { status: "blocked", at: 300 }],
    ["d1", { status: "done", at: 50 }],
    ["w1", { status: "working", at: 200 }],
    ["i1", { status: "idle", at: 400 }],
    ["u1", { status: "unknown", at: 500 }],
  ]);

  const sorted = g.activitySort(agents, since);
  assert.deepEqual(
    sorted.map((a) => a.address),
    ["b2", "b1", "d1", "w1", "i1", "u1"]
  );
  // Does not mutate original array
  assert.equal(agents[0].address, "i1");
});

test("attentionCount counts blocked and done agents", () => {
  assert.equal(g.attentionCount([]), 0);
  assert.equal(
    g.attentionCount([
      { address: "a", status: "blocked" },
      { address: "b", status: "working" },
      { address: "c", status: "done" },
      { address: "d", status: "idle" },
      { address: "e", status: "blocked" },
    ]),
    3
  );
});

test("sortGroups supports added and name", () => {
  const groups = [
    { key: "other", name: "Other", kind: "other", rows: [] },
    { key: "/z", name: "Zebra", kind: "repo", rows: [] },
    { key: "machine:vps", name: "vps", kind: "machine", rows: [] },
    { key: "/a", name: "alpha", kind: "repo", rows: [] },
    { key: "/b", name: "Beta", kind: "repo", rows: [] },
  ];

  const added = g.sortGroups(groups, "added");
  assert.deepEqual(added.map((x) => x.key), ["other", "/z", "machine:vps", "/a", "/b"]);
  assert.notEqual(added, groups);

  const byName = g.sortGroups(groups, "name");
  assert.deepEqual(byName.map((x) => x.key), ["/a", "/b", "/z", "machine:vps", "other"]);
});

test("hideMainRows filters out main rows while keeping all groups", () => {
  const groups = [
    {
      key: "/r1",
      name: "r1",
      kind: "repo",
      rows: [
        { space: sp("m1"), main: true },
        { space: sp("w1"), main: false },
      ],
    },
    {
      key: "/r2",
      name: "r2",
      kind: "repo",
      rows: [{ space: sp("m2"), main: true }],
    },
  ];

  const hidden = g.hideMainRows(groups);
  assert.equal(hidden.length, 2);
  assert.deepEqual(hidden[0].rows.map((r) => r.space.id), ["w1"]);
  assert.deepEqual(hidden[1].rows, []);
  // Does not mutate original groups
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[1].rows.length, 1);
});

test("sleeping record attaches to matching open space row", () => {
  const m = sp("m", { folder: "/r" });
  const w1 = sp("w1", { folder: "/wt/a" });
  const repoMap = {
    "/r": { primary: "/r", linked: false },
    "/wt/a": { primary: "/r", linked: true },
  };
  const rec = {
    version: 1,
    sleptAt: 1000,
    branch: "feat/a",
    repo: "/r",
    agents: [{ name: "Claude Code", kind: "claude", cwd: "/wt/a", command: "claude --resume 1" }],
  };

  const groups = g.group([m, w1], (s) => s.folder, (p) => repoMap[p], {
    sleeping: { "/wt/a": rec },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 2);
  assert.equal(groups[0].rows[0].space.id, "m");
  assert.equal(groups[0].rows[0].sleeping, undefined);
  assert.equal(groups[0].rows[1].space.id, "w1");
  assert.deepEqual(groups[0].rows[1].sleeping, rec);
});

test("sleeping record without open space adds row after space rows ordered newest sleptAt first", () => {
  const m = sp("m", { folder: "/r" });
  const repoMap = { "/r": { primary: "/r", linked: false } };
  const recOld = {
    version: 1,
    sleptAt: 1000,
    branch: "feat/old",
    repo: "/r",
    agents: [{ name: "Codex", kind: "codex", cwd: "/wt/old", command: "codex resume 12345678" }],
  };
  const recNew = {
    version: 1,
    sleptAt: 2000,
    branch: "feat/new",
    repo: "/r",
    agents: [{ name: "Claude Code", kind: "claude", cwd: "/wt/new", command: "claude --resume 1" }],
  };

  const groups = g.group([m], (s) => s.folder, (p) => repoMap[p], {
    sleeping: {
      "/wt/old": recOld,
      "/wt/new": recNew,
    },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 3);
  assert.equal(groups[0].rows[0].space.id, "m");
  assert.deepEqual(groups[0].rows[1], {
    space: null,
    worktree: "/wt/new",
    sleeping: recNew,
    main: false,
  });
  assert.deepEqual(groups[0].rows[2], {
    space: null,
    worktree: "/wt/old",
    sleeping: recOld,
    main: false,
  });
});

test("saved-only project with sleeping worktree gets the sleeping row", () => {
  const rec = {
    version: 1,
    sleptAt: 1500,
    branch: "feat/s",
    repo: "/saved",
    agents: [{ name: "Codex", kind: "codex", cwd: "/wt/s", command: "codex resume 12345678" }],
  };
  const groups = g.group([], (s) => s.folder, () => null, {
    saved: [{ path: "/saved", exists: true }],
    sleeping: { "/wt/s": rec },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "/saved");
  assert.equal(groups[0].rows.length, 1);
  assert.deepEqual(groups[0].rows[0], {
    space: null,
    worktree: "/wt/s",
    sleeping: rec,
    main: false,
  });
});

test("visibleRows keeps active sleeping row when collapsed and hides space: null rows", () => {
  const rec = { version: 1, sleptAt: 1000, branch: "b", agents: [] };
  const rowActiveSleeping = { space: sp("a", { active: true }), main: false, sleeping: rec };
  const rowInactiveSleeping = { space: sp("b", { active: false }), main: false, sleeping: rec };
  const rowNoSpace = { space: null, worktree: "/wt/c", sleeping: rec, main: false };
  const grp = {
    key: "/r",
    name: "r",
    kind: "repo",
    primary: "/r",
    primarySpace: null,
    rows: [rowActiveSleeping, rowInactiveSleeping, rowNoSpace],
  };

  assert.deepEqual(g.visibleRows(grp, true), [rowActiveSleeping]);
  assert.deepEqual(g.visibleRows(grp, false), [rowActiveSleeping, rowInactiveSleeping, rowNoSpace]);
});

test("label handles no-space sleeping rows using branch or folder basename", () => {
  assert.equal(
    g.label({ space: null, worktree: "/wt/my-wt", sleeping: { branch: "feat/sleep" } }),
    "feat/sleep"
  );
  assert.equal(
    g.label({ space: null, worktree: "/wt/my-wt", sleeping: { branch: null } }),
    "my-wt"
  );
  assert.equal(
    g.label({ space: null, worktree: "/wt/my-wt/", sleeping: {} }),
    "my-wt"
  );
  assert.equal(
    g.label({ space: sp("s1", { named: false, name: "r", branch: "feat/open" }), main: false }),
    "feat/open"
  );
});

test("topStatus picks the most urgent status", () => {
  assert.equal(g.topStatus([{ status: "done" }, { status: "blocked" }, { status: "working" }]), "blocked");
  assert.equal(g.topStatus([{ status: "idle" }, { status: "working" }]), "working");
  assert.equal(g.topStatus([{ status: "idle" }, { status: "done" }]), "done");
  assert.equal(g.topStatus([{ status: "weird" }, {}]), null);
  assert.equal(g.topStatus([]), null);
});

test("agentSummary caps icons at 5", () => {
  const a = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(g.agentSummary(a), { icons: [1, 2, 3, 4, 5], more: 2 });
  assert.deepEqual(g.agentSummary([1, 2]), { icons: [1, 2], more: 0 });
  assert.deepEqual(g.agentSummary([1, 2, 3], 2), { icons: [1, 2], more: 1 });
});

test("STATUS_GLYPH", () => {
  assert.deepEqual({ ...g.STATUS_GLYPH }, { blocked: "!", working: "●", done: "✓", idle: "○" });
});

const G = (name, group, kind = "repo") => ({ kind, key: name, name, displayName: name, group, rows: [] });

test("projectGroups puts named groups first in first-appearance order", () => {
  const s = g.projectGroups([G("a", null), G("b", "CTM"), G("c", "Zed"), G("d", " ctm "), G("other", null, "other")]);
  assert.deepEqual(
    s.map((x) => [x.name, x.key, x.projects.map((p) => p.name)]),
    [
      ["CTM", "group:ctm", ["b", "d"]],
      ["Zed", "group:zed", ["c"]],
      [null, null, ["a", "other"]],
    ]
  );
});

test("projectGroups name sort orders groups and their projects", () => {
  const s = g.projectGroups([G("y", "Zed"), G("x", "Zed"), G("b", "Alpha"), G("a", null)], "name");
  assert.deepEqual(
    s.map((x) => [x.name, x.projects.map((p) => p.name)]),
    [
      ["Alpha", ["b"]],
      ["Zed", ["x", "y"]],
      [null, ["a"]],
    ]
  );
});

test("projectGroups with no groups is one unnamed section", () => {
  assert.deepEqual(g.projectGroups([G("a", null)]).map((x) => x.name), [null]);
});

test("group carries saved group onto repo group", () => {
  const groups = g.group([], (s) => s.folder, () => null, {
    saved: [
      { path: "/a", exists: true, name: "A", icon: null, group: "CTM group" },
      { path: "/b", exists: true, name: "B", icon: null, group: null },
    ],
  });
  assert.equal(groups[0].group, "CTM group");
  assert.equal(groups[1].group, null);
});
