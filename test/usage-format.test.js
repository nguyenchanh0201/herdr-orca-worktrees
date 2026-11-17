const test = require("node:test");
const assert = require("node:assert/strict");

const { until, headline, barColor } = require("../src/usage/format");

test("until formats durations and edge cases", () => {
  const now = 1_700_000_000_000;
  assert.equal(until(now + 59_000, now), "0m");
  assert.equal(until(now + 60_000, now), "1m");
  assert.equal(until(now + 3_599_000, now), "59m");
  assert.equal(until(now + 3_600_000, now), "1h 0m");
  assert.equal(until(now + 86_400_000, now), "1d 0h");
  assert.equal(until(now - 1, now), "now");
  assert.equal(until(null, now), "");
});

test("headline formats highest-utilization window and empty/error states", () => {
  const now = 1_700_000_000_000;
  const resets3h12m = now + 3 * 3_600_000 + 12 * 60_000;

  assert.equal(
    headline(
      {
        status: "ok",
        windows: [
          { label: "5h", minutes: 300, usedPercent: 42, resetsAt: resets3h12m },
          { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: now + 86_400_000 },
        ],
      },
      now
    ),
    "42% 3h 12m"
  );

  assert.equal(
    headline(
      {
        status: "ok",
        windows: [
          { label: "Pro", minutes: 0, usedPercent: 10, resetsAt: null },
          { label: "Flash", minutes: 0, usedPercent: 30, resetsAt: null },
        ],
      },
      now
    ),
    "Flash 30%"
  );

  assert.equal(
    headline(
      {
        status: "ok",
        windows: [{ label: "5h", minutes: 300, usedPercent: 42, resetsAt: null }],
      },
      now
    ),
    "42% 5h"
  );

  assert.equal(headline({ status: "ok", windows: [] }, now), "--");
  assert.equal(headline({}, now), "···");
  assert.equal(headline({ status: "error", windows: [] }, now), "");
});

test("barColor maps usage percentage to ANSI color names", () => {
  assert.equal(barColor(79), "ansi2");
  assert.equal(barColor(80), "ansi3");
  assert.equal(barColor(90), "ansi1");
});
