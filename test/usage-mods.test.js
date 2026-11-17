const test = require("node:test");
const assert = require("node:assert/strict");

const cjsFormat = require("../src/usage/format");

test("ESM format.js copies match src/usage/format.js on all Task 1 cases", async () => {
  const stripFormat = await import("../mods/orca-usage/format.js");
  const panelFormat = await import("../mods/orca-usage-panel/format.js");

  const now = 1_700_000_000_000;
  const resets3h12m = now + 3 * 3_600_000 + 12 * 60_000;

  const untilArgs = [
    [now + 59_000, now],
    [now + 60_000, now],
    [now + 3_599_000, now],
    [now + 3_600_000, now],
    [now + 86_400_000, now],
    [now - 1, now],
    [null, now],
  ];

  const headlineArgs = [
    [
      {
        status: "ok",
        windows: [
          { label: "5h", minutes: 300, usedPercent: 42, resetsAt: resets3h12m },
          { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: now + 86_400_000 },
        ],
      },
      now,
    ],
    [
      {
        status: "ok",
        windows: [
          { label: "Pro", minutes: 0, usedPercent: 10, resetsAt: null },
          { label: "Flash", minutes: 0, usedPercent: 30, resetsAt: null },
        ],
      },
      now,
    ],
    [
      {
        status: "ok",
        windows: [{ label: "5h", minutes: 300, usedPercent: 42, resetsAt: null }],
      },
      now,
    ],
    [{ status: "ok", windows: [] }, now],
    [{}, now],
    [{ status: "error", windows: [] }, now],
  ];

  const barColors = [59, 60, 79, 80];

  const wf = (label, minutes, usedPercent) => ({ label, minutes, usedPercent, resetsAt: null });
  const shortArgs = [wf("Session", 300, 1), wf("Weekly", 10080, 1), wf("Fable", 10080, 1), wf("Pro", 0, 1)];
  const detailArgs = [
    { id: "claude", windows: [wf("5h", 300, 85.4), wf("Weekly", 10080, 64), wf("Fable", 10080, 120)] },
    { id: "agy", windows: [wf("Gemini Models · Weekly Limit Remaining", 10080, 27), wf("Gemini 4 Argon", 0, -3)] },
    { id: "codex", windows: [] },
    { id: "codex" },
  ];

  const shortGroupArgs = [
    "Gemini 3.1 Pro Models · 5h",
    "Claude Models · Weekly",
    "Fable · 5h",
    "Codex Models",
    "5h",
  ];

  const chipTextArgs = [
    [null, "compact", now],
    [{}, "compact", now],
    [{ status: "ok", windows: [] }, "compact", now],
    [{ status: "error", windows: [] }, "compact", now],
    [
      {
        status: "ok",
        windows: [
          { label: "5h", minutes: 300, usedPercent: 42.4, resetsAt: resets3h12m },
          { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: now + 86_400_000 },
        ],
      },
      "compact",
      now,
    ],
    [
      {
        status: "ok",
        windows: [
          { label: "5h", minutes: 300, usedPercent: 42.4, resetsAt: resets3h12m },
          { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: now + 86_400_000 },
        ],
      },
      "detailed",
      now,
    ],
    [
      {
        status: "ok",
        windows: [
          { label: "Gemini 3.1 Pro Models · 5h", minutes: 300, usedPercent: 25, resetsAt: resets3h12m },
          { label: "Gemini 3.1 Pro Models · Weekly", minutes: 10080, usedPercent: 60, resetsAt: null },
          { label: "Fable · 5h", minutes: 300, usedPercent: 60, resetsAt: null },
        ],
      },
      "compact",
      now,
    ],
    [
      {
        status: "ok",
        windows: [
          { label: "Gemini 3.1 Pro Models · 5h", minutes: 300, usedPercent: 25, resetsAt: resets3h12m },
          { label: "Gemini 3.1 Pro Models · Weekly", minutes: 10080, usedPercent: 60, resetsAt: null },
          { label: "Fable · 5h", minutes: 300, usedPercent: 60, resetsAt: null },
        ],
      },
      "detailed",
      now,
    ],
  ];

  const windowNameArgs = [
    { label: "Fable", minutes: 300 },
    { label: "5h", minutes: 300 },
    { label: "7d", minutes: 10080 },
    { label: "Gemini 3.1 Pro", minutes: 0 },
  ];

  const updatedTextArgs = [
    [null, now],
    [now - 10_000, now],
    [now - 60_000, now],
    [now - 3_600_000, now],
  ];

  for (const mod of [stripFormat, panelFormat]) {
    for (const args of untilArgs) {
      assert.equal(mod.until(...args), cjsFormat.until(...args));
    }
    for (const args of headlineArgs) {
      assert.equal(mod.headline(...args), cjsFormat.headline(...args));
    }
    for (const pct of barColors) {
      assert.equal(mod.barColor(pct), cjsFormat.barColor(pct));
    }
    for (const label of shortGroupArgs) {
      assert.equal(mod.shortGroup(label), cjsFormat.shortGroup(label));
    }
    for (const args of chipTextArgs) {
      assert.equal(mod.chipText(...args), cjsFormat.chipText(...args));
    }
    for (const w of windowNameArgs) {
      assert.equal(mod.windowName(w), cjsFormat.windowName(w));
    }
    for (const args of updatedTextArgs) {
      assert.equal(mod.updatedText(...args), cjsFormat.updatedText(...args));
    }
    for (const w of shortArgs) {
      assert.equal(mod.windowShort(w), cjsFormat.windowShort(w));
    }
    for (const p of detailArgs) {
      assert.deepEqual(mod.detailLines(p), cjsFormat.detailLines(p));
    }
  }
});

test("merge keeps last ok windows on error", async () => {
  const { merge } = await import("../mods/orca-usage/merge.js");
  const prev = [
    {
      id: "claude",
      status: "ok",
      windows: [{ label: "5h", minutes: 300, usedPercent: 42, resetsAt: 1_800_000_000_000 }],
      fetchedAt: 1000,
    },
  ];
  const next = [
    {
      id: "claude",
      status: "error",
      error: "Rate limited",
      windows: [],
      fetchedAt: 2000,
    },
  ];
  const res = merge(prev, next, []);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, "claude");
  assert.equal(res[0].status, "error");
  assert.equal(res[0].error, "Rate limited");
  assert.deepEqual(res[0].windows, prev[0].windows);
});

test("merge clears windows on unavailable", async () => {
  const { merge } = await import("../mods/orca-usage/merge.js");
  const prev = [
    {
      id: "agy",
      status: "ok",
      windows: [{ label: "Flash", minutes: 0, usedPercent: 25, resetsAt: null }],
      fetchedAt: 1000,
    },
  ];
  const next = [
    {
      id: "agy",
      status: "unavailable",
      error: "Sign in with agy",
      windows: [],
      fetchedAt: 2000,
      manualOnly: true,
    },
  ];
  const res = merge(prev, next, []);
  assert.equal(res.length, 1);
  assert.equal(res[0].status, "unavailable");
  assert.deepEqual(res[0].windows, []);
  assert.equal(res[0].error, "Sign in with agy");
});

test("merge keeps skipped ids unchanged from prev", async () => {
  const { merge } = await import("../mods/orca-usage/merge.js");
  const prev = [
    {
      id: "claude",
      status: "ok",
      windows: [{ label: "5h", minutes: 300, usedPercent: 10, resetsAt: 100 }],
      fetchedAt: 1000,
    },
    {
      id: "agy",
      status: "unavailable",
      error: "Sign in with agy",
      windows: [],
      fetchedAt: 1000,
      manualOnly: true,
    },
  ];
  const next = [
    {
      id: "claude",
      status: "ok",
      windows: [{ label: "5h", minutes: 300, usedPercent: 20, resetsAt: 200 }],
      fetchedAt: 2000,
    },
  ];
  const res = merge(prev, next, ["agy"]);
  assert.deepEqual(res.map((p) => p.id), ["claude", "agy"]);
  assert.equal(res[0].windows[0].usedPercent, 20);
  assert.deepEqual(res[1], prev[1]);
});

test("merge adds new providers and maintains canonical order", async () => {
  const { merge } = await import("../mods/orca-usage/merge.js");
  const prev = [
    { id: "agy", status: "ok", windows: [], fetchedAt: 1000 },
  ];
  const next = [
    { id: "codex", status: "ok", windows: [], fetchedAt: 2000 },
    { id: "claude", status: "ok", windows: [], fetchedAt: 2000 },
    { id: "custom", status: "ok", windows: [], fetchedAt: 2000 },
  ];
  const res = merge(prev, next, []);
  assert.deepEqual(res.map((p) => p.id), ["claude", "codex", "agy", "custom"]);
});
