const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  keychainCandidates,
  keychainAccount,
  mapClaudeUsage,
  fetchClaude,
} = require("../src/usage/claude");

test("keychainCandidates returns hashed candidate first when CLAUDE_CONFIG_DIR is set", () => {
  const hash = crypto.createHash("sha256").update("/x").digest("hex").slice(0, 8);
  assert.deepEqual(keychainCandidates({ CLAUDE_CONFIG_DIR: "/x" }), [
    `Claude Code-credentials-${hash}`,
    "Claude Code-credentials",
  ]);
  assert.deepEqual(keychainCandidates({}), ["Claude Code-credentials"]);
  assert.deepEqual(keychainCandidates({ CLAUDE_CONFIG_DIR: "" }), [
    "Claude Code-credentials",
  ]);
});

test("keychainAccount validates username characters", () => {
  assert.equal(keychainAccount("jimmy_nguyen"), "jimmy_nguyen");
  assert.equal(keychainAccount("a b"), "claude-code-user");
  assert.equal(keychainAccount(""), "claude-code-user");
  assert.equal(keychainAccount(undefined), "claude-code-user");
});

test("mapClaudeUsage maps five_hour, seven_day, resets_at formats, and skips missing windows", () => {
  const iso = "2026-11-17T12:00:00Z";
  const sec = 1794916800;
  const ms = 1794916800000;

  assert.deepEqual(
    mapClaudeUsage({
      five_hour: { utilization: 42.4, resets_at: iso },
      seven_day: { used_percentage: 17.6, resets_at: sec },
    }),
    [
      { label: "5h", minutes: 300, usedPercent: 42, resetsAt: Date.parse(iso) },
      { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: sec * 1000 },
    ]
  );

  assert.deepEqual(
    mapClaudeUsage({
      five_hour: { utilization: 10, resets_at: ms },
      seven_day: null,
    }),
    [{ label: "5h", minutes: 300, usedPercent: 10, resetsAt: ms }]
  );

  assert.deepEqual(mapClaudeUsage({}), []);
});

test("mapClaudeUsage maps all four Fable forms", () => {
  assert.deepEqual(
    mapClaudeUsage({
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { display_name: "Fable" } },
          percent: 33.2,
          resets_at: 1794916800000,
        },
      ],
    }),
    [{ label: "Fable", minutes: 10080, usedPercent: 33, resetsAt: 1794916800000 }]
  );

  assert.deepEqual(
    mapClaudeUsage({ fable_weekly: { utilization: 25, resets_at: null } }),
    [{ label: "Fable", minutes: 10080, usedPercent: 25, resetsAt: null }]
  );

  assert.deepEqual(
    mapClaudeUsage({ fable_seven_day: { used_percentage: 50 } }),
    [{ label: "Fable", minutes: 10080, usedPercent: 50, resetsAt: null }]
  );

  assert.deepEqual(
    mapClaudeUsage({ seven_day_fable: { utilization: 75 } }),
    [{ label: "Fable", minutes: 10080, usedPercent: 75, resetsAt: null }]
  );
});

test("fetchClaude handles missing credentials, denied keychain, and file fallback", async () => {
  const now = 1794900000000;

  const unavail = await fetchClaude({
    readSecret: () => ({ ok: false, missing: true }),
    readFile: () => null,
    fetchImpl: () => {
      throw new Error("should not fetch");
    },
    env: { USER: "jimmy_nguyen", HOME: "/tmp/home" },
    now,
  });
  assert.deepEqual(unavail, {
    id: "claude",
    status: "unavailable",
    error: "Not signed in",
    windows: [],
    fetchedAt: now,
  });

  const denied = await fetchClaude({
    readSecret: () => ({ ok: false, missing: false }),
    readFile: () => null,
    fetchImpl: () => {
      throw new Error("should not fetch");
    },
    env: { USER: "jimmy_nguyen", HOME: "/tmp/home" },
    now,
  });
  assert.deepEqual(denied, {
    id: "claude",
    status: "error",
    error: "Allow keychain access for Claude usage",
    windows: [],
    fetchedAt: now,
  });

  let readPath = null;
  const fromFile = await fetchClaude({
    readSecret: () => ({ ok: false, missing: true }),
    readFile: (p) => {
      readPath = p;
      return JSON.stringify({ claudeAiOauth: { accessToken: "file-tok" } });
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ five_hour: { utilization: 12 } }),
    }),
    env: { USER: "jimmy_nguyen", HOME: "/tmp/home" },
    now,
  });
  assert.equal(readPath, "/tmp/home/.claude/.credentials.json");
  assert.deepEqual(fromFile, {
    id: "claude",
    status: "ok",
    windows: [{ label: "5h", minutes: 300, usedPercent: 12, resetsAt: null }],
    fetchedAt: now,
  });
});

test("fetchClaude sends expected URL and headers and maps HTTP/network errors", async () => {
  const now = 1794900000000;
  let seenUrl = null;
  let seenInit = null;

  const okRes = await fetchClaude({
    readSecret: () => ({
      ok: true,
      value: JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }),
    }),
    readFile: () => null,
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    },
    env: { USER: "jimmy_nguyen" },
    now,
  });
  assert.equal(okRes.status, "ok");
  assert.equal(seenUrl, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(seenInit.method, "GET");
  assert.deepEqual(seenInit.headers, {
    Authorization: "Bearer tok-123",
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": "claude-code/2.1.0",
  });
  assert.ok(seenInit.signal);

  const r401 = await fetchClaude({
    readSecret: () => ({ ok: true, value: "tok" }),
    readFile: () => null,
    fetchImpl: async () => ({ ok: false, status: 401 }),
    now,
  });
  assert.equal(r401.status, "error");
  assert.equal(r401.error, "Updates the next time Claude runs");

  const r429 = await fetchClaude({
    readSecret: () => ({ ok: true, value: "tok" }),
    readFile: () => null,
    fetchImpl: async () => ({ ok: false, status: 429 }),
    now,
  });
  assert.equal(r429.status, "error");
  assert.equal(r429.error, "Rate limited");

  const r500 = await fetchClaude({
    readSecret: () => ({ ok: true, value: "tok" }),
    readFile: () => null,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    now,
  });
  assert.equal(r500.status, "error");
  assert.match(r500.error, /500/);

  const rThrow = await fetchClaude({
    readSecret: () => ({ ok: true, value: "tok" }),
    readFile: () => null,
    fetchImpl: async () => {
      throw new Error("network down");
    },
    now,
  });
  assert.equal(rThrow.status, "error");
  assert.equal(rThrow.error, "network down");
});

test("claude errors never include the token", async () => {
  const token = "sk-ant-SECRET";
  const cases = [
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: false, status: 500 }),
    async () => {
      throw new Error(`request failed for Bearer ${token}`);
    },
  ];

  for (const fetchImpl of cases) {
    const result = await fetchClaude({
      readSecret: () => ({ ok: true, value: token }),
      readFile: () => null,
      fetchImpl,
      now: 1794900000000,
    });
    assert.equal(result.status, "error");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
});
