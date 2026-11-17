const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mapCodexLimits, fetchCodex } = require("../src/usage/codex");

const FAKE_CODEX = path.join(__dirname, "fixtures", "usage", "fake-codex.js");

describe("mapCodexLimits", () => {
  it("maps 300 and 10080 minute windows to 5h and Weekly with ms resetsAt", () => {
    const windows = mapCodexLimits({
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1800500000 },
      },
    });
    assert.deepEqual(windows, [
      { label: "5h", minutes: 300, usedPercent: 42, resetsAt: 1800000000 * 1000 },
      { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: 1800500000 * 1000 },
    ]);
  });

  it("maps durations within +-1 minute (299 and 10081)", () => {
    const windows = mapCodexLimits({
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 299, resetsAt: 1800000000 },
        secondary: { usedPercent: 20, windowDurationMins: 10081, resetsAt: 1800500000 },
      },
    });
    assert.equal(windows[0].label, "5h");
    assert.equal(windows[0].minutes, 300);
    assert.equal(windows[1].label, "Weekly");
    assert.equal(windows[1].minutes, 10080);
  });

  it("maps unknown durations using primary -> 5h and secondary -> Weekly", () => {
    const windows = mapCodexLimits({
      rateLimits: {
        primary: { usedPercent: 55, windowDurationMins: 60, resetsAt: 1800000000 },
        secondary: { usedPercent: 33, windowDurationMins: 43200, resetsAt: 1800500000 },
      },
    });
    assert.equal(windows[0].label, "5h");
    assert.equal(windows[0].minutes, 300);
    assert.equal(windows[1].label, "Weekly");
    assert.equal(windows[1].minutes, 10080);
  });

  it("skips null windows", () => {
    const windows = mapCodexLimits({
      rateLimits: {
        primary: null,
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: null },
      },
    });
    assert.deepEqual(windows, [
      { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: null },
    ]);
  });
});

describe("fetchCodex", () => {
  it("returns ok with 2 windows on happy path", async () => {
    const res = await fetchCodex({
      command: FAKE_CODEX,
      env: { ...process.env, FAKE_CODEX_MODE: "ok" },
      now: 123456,
    });
    assert.equal(res.id, "codex");
    assert.equal(res.status, "ok");
    assert.equal(res.fetchedAt, 123456);
    assert.equal(res.windows.length, 2);
    assert.equal(res.windows[0].label, "5h");
    assert.equal(res.windows[0].usedPercent, 42);
    assert.equal(res.windows[1].label, "Weekly");
    assert.equal(res.windows[1].usedPercent, 18);
  });

  it("succeeds on slow start within timeout", async () => {
    const res = await fetchCodex({
      command: FAKE_CODEX,
      env: { ...process.env, FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY: "300" },
      timeouts: { init: 1000, read: 1000 },
      now: 123456,
    });
    assert.equal(res.status, "ok");
    assert.equal(res.windows.length, 2);
  });

  it("returns error and kills child on silent timeout", async () => {
    const res = await fetchCodex({
      command: FAKE_CODEX,
      env: { ...process.env, FAKE_CODEX_MODE: "silent" },
      timeouts: { init: 300, read: 300 },
      now: 123456,
    });
    assert.equal(res.id, "codex");
    assert.equal(res.status, "error");
    assert.equal(res.error, "Codex did not answer");
    assert.deepEqual(res.windows, []);
  });

  it("returns unavailable Not signed in on auth JSON-RPC error", async () => {
    const res = await fetchCodex({
      command: FAKE_CODEX,
      env: { ...process.env, FAKE_CODEX_MODE: "error" },
      now: 123456,
    });
    assert.equal(res.id, "codex");
    assert.equal(res.status, "unavailable");
    assert.equal(res.error, "Not signed in");
    assert.deepEqual(res.windows, []);
  });

  it("returns unavailable Not installed when command is missing", async () => {
    const res = await fetchCodex({
      command: "/no/such/codex",
      now: 123456,
    });
    assert.equal(res.id, "codex");
    assert.equal(res.status, "unavailable");
    assert.equal(res.error, "Not installed");
    assert.deepEqual(res.windows, []);
  });
});
