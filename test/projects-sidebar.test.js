const test = require("node:test");
const assert = require("node:assert/strict");

let s;

test.before(async () => {
  s = await import("../mods/projects/sidebar.js");
});

const S0 = { seenWide: false, hidden: null };

test("findNode finds nested", () => {
  const tree = {
    id: "r",
    children: [{ id: "a", children: [{ id: "sidebar", size: { px: 90 } }] }],
  };
  assert.equal(s.findNode(tree, "sidebar").size.px, 90);
  assert.equal(s.findNode(tree, "missing"), null);
});

test("restore clamps", () => {
  assert.equal(s.restoreWidth(90), 220);
  assert.equal(s.restoreWidth(900), 500);
  assert.equal(s.restoreWidth(300), 300);
});

test("restore default", () => {
  assert.equal(s.restoreWidth(undefined), 268);
  assert.equal(s.restoreWidth("x"), 268);
});

test("startup narrow only resizes", () => {
  const r = s.sidebarStep({ size: { px: 90 } }, S0, 300);
  assert.equal(r.resize, 300);
  assert.equal(r.hide, false);
  assert.equal(r.state.seenWide, false);
});

test("toggle after wide hides", () => {
  const r1 = s.sidebarStep({ size: { px: 268 } }, S0, 268);
  assert.equal(r1.resize, null);
  assert.equal(r1.state.seenWide, true);

  const r2 = s.sidebarStep({ size: { px: 76 } }, r1.state, 268);
  assert.equal(r2.resize, 268);
  assert.equal(r2.hide, true);
  assert.equal(r2.state.hidden, true);
});

test("hides again after show", () => {
  const r1 = s.sidebarStep(
    { size: { px: 268 }, hidden: false },
    { seenWide: false, hidden: true },
    268,
  );
  assert.equal(r1.hiddenChanged, true);
  assert.equal(r1.state.seenWide, true);

  const r2 = s.sidebarStep({ size: { px: 76 } }, r1.state, 268);
  assert.equal(r2.hide, true);
});

test("hidden change reported", () => {
  const r = s.sidebarStep(
    { size: { px: 268 }, hidden: true },
    { seenWide: true, hidden: false },
    268,
  );
  assert.equal(r.hiddenChanged, true);
  assert.equal(r.resize, null);
  assert.equal(r.state.seenWide, false);
});

test("null node is a no-op", () => {
  const r = s.sidebarStep(null, S0, 1);
  assert.equal(r.resize, null);
  assert.equal(r.hide, false);
  assert.equal(r.hiddenChanged, false);
  assert.deepEqual(r.state, S0);
});
