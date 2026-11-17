const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { versionAtLeast, parseAgyUsage, fetchAgy } = require("../src/usage/agy");

const FIXTURES = path.join(__dirname, "fixtures", "usage");
const FAKE_AGY = path.join(FIXTURES, "fake-agy.js");

describe("versionAtLeast", () => {
  it("checks semver minimum", () => {
    assert.equal(versionAtLeast("1.1.10", "1.1.11"), false);
    assert.equal(versionAtLeast("1.1.11", "1.1.11"), true);
    assert.equal(versionAtLeast("1.5.9", "1.1.11"), true);
    assert.equal(versionAtLeast("agy 1.5.9", "1.1.11"), true);
  });
});

describe("parseAgyUsage", () => {
  it("parses one-bucket group using group name", () => {
    const stdout = fs.readFileSync(path.join(FIXTURES, "agy-one-bucket.json"), "utf8");
    const parsed = parseAgyUsage(stdout, "");
    assert.ok(parsed.windows);
    assert.equal(parsed.windows.length, 1);
    assert.deepEqual(parsed.windows[0], {
      label: "Claude",
      minutes: 10080,
      usedPercent: 38,
      resetsAt: Date.parse("2026-11-24T00:00:00Z"),
    });
  });

  it("parses multi-bucket group and drops disabled buckets", () => {
    const stdout = fs.readFileSync(path.join(FIXTURES, "agy-multi-bucket.json"), "utf8");
    const parsed = parseAgyUsage(stdout, "");
    assert.ok(parsed.windows);
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.windows[0].label, "Gemini · Flash");
    assert.equal(parsed.windows[0].minutes, 300);
    assert.equal(parsed.windows[0].usedPercent, 30);
    assert.equal(parsed.windows[1].label, "Gemini · Pro");
    assert.equal(parsed.windows[1].minutes, 10080);
    assert.equal(parsed.windows[1].usedPercent, 10);
  });

  it("returns error on ERROR status", () => {
    const stdout = fs.readFileSync(path.join(FIXTURES, "agy-error.json"), "utf8");
    const parsed = parseAgyUsage(stdout, "");
    assert.deepEqual(parsed, { error: "quota check failed" });
  });

  it("returns stopAsking on model turn output", () => {
    const stdout = fs.readFileSync(path.join(FIXTURES, "agy-model-turn.json"), "utf8");
    const parsed = parseAgyUsage(stdout, "");
    assert.deepEqual(parsed, { stopAsking: true });
  });

  it("returns signedOut on signed-out text", () => {
    const stderr = fs.readFileSync(path.join(FIXTURES, "agy-signed-out.txt"), "utf8");
    const parsed = parseAgyUsage("", stderr);
    assert.deepEqual(parsed, { signedOut: true });
  });

  it("returns generic error on garbage stdout", () => {
    const parsed = parseAgyUsage("not json at all\n", "");
    assert.deepEqual(parsed, { error: "Couldn't read agy usage" });
  });
});

describe("fetchAgy", () => {
  it("returns unavailable with manualOnly when signed out", async () => {
    const res = await fetchAgy({
      command: FAKE_AGY,
      env: {
        ...process.env,
        FAKE_AGY_VERSION: "1.5.0",
        FAKE_AGY_ERR: path.join(FIXTURES, "agy-signed-out.txt"),
        FAKE_AGY_EXIT: "1",
      },
      now: 123456,
    });
    assert.equal(res.id, "agy");
    assert.equal(res.status, "unavailable");
    assert.equal(res.manualOnly, true);
    assert.equal(res.error, "Sign in with agy");
    assert.deepEqual(res.windows, []);
  });

  it("gates old versions without calling /usage", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
    const marker = path.join(tmpDir, "called.marker");
    try {
      const res = await fetchAgy({
        command: FAKE_AGY,
        env: {
          ...process.env,
          FAKE_AGY_VERSION: "1.1.10",
          FAKE_AGY_MARKER: marker,
        },
        now: 123456,
      });
      assert.equal(res.id, "agy");
      assert.equal(res.status, "unavailable");
      assert.equal(res.error, "Update agy to show usage");
      assert.equal(fs.existsSync(marker), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns unavailable Not installed when command is missing", async () => {
    const res = await fetchAgy({
      command: "/no/such/agy",
      now: 123456,
    });
    assert.equal(res.id, "agy");
    assert.equal(res.status, "unavailable");
    assert.equal(res.error, "Not installed");
    assert.deepEqual(res.windows, []);
  });
});
