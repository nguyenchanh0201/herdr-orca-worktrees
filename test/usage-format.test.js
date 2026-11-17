const test = require("node:test");
const assert = require("node:assert/strict");

const {
  until,
  headline,
  barColor,
  shortGroup,
  chipText,
  windowName,
  updatedText,
  windowShort,
  detailLines,
} = require("../src/usage/format");

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

test("barColor: red from 80, yellow from 60", () => {
  assert.equal(barColor(59), "muted");
  assert.equal(barColor(60), "ansi3");
  assert.equal(barColor(79), "ansi3");
  assert.equal(barColor(80), "ansi1");
});

test("windowShort", () => {
  assert.equal(windowShort({ label: "Session", minutes: 300 }), "5h");
  assert.equal(windowShort({ label: "Weekly", minutes: 10080 }), "wk");
  assert.equal(windowShort({ label: "Fable", minutes: 10080 }), "Fable"); // label wins
  assert.equal(windowShort({ label: "Pro", minutes: 0 }), "Pro");
});

test("detailLines: one line for claude/codex, one per window for agy", () => {
  const w = (label, minutes, usedPercent) => ({ label, minutes, usedPercent, resetsAt: null });
  assert.deepEqual(
    detailLines({ id: "claude", windows: [w("5h", 300, 85.4), w("Weekly", 10080, 64), w("Fable", 10080, 120)] }),
    [[{ label: "5h", pct: 85 }, { label: "wk", pct: 64 }, { label: "Fable", pct: 100 }]]
  );
  assert.deepEqual(
    detailLines({ id: "agy", windows: [w("Gemini Models · Weekly Limit Remaining", 10080, 27), w("Gemini 4 Argon", 0, -3)] }),
    [[{ label: "Gemini Models · Weekly Limit Remaining", pct: 27 }], [{ label: "Gemini 4 Argon", pct: 0 }]]
  );
  assert.deepEqual(detailLines({ id: "codex", windows: [] }), []);
  assert.deepEqual(detailLines({ id: "codex" }), []);
});

test("shortGroup extracts group name before separator and strips Models suffix", () => {
  assert.equal(shortGroup("Gemini 3.1 Pro Models · 5h"), "Gemini 3.1 Pro");
  assert.equal(shortGroup("Claude Models · Weekly"), "Claude");
  assert.equal(shortGroup("Fable · 5h"), "Fable");
  assert.equal(shortGroup("Codex Models"), "Codex");
  assert.equal(shortGroup("5h"), "5h");
});

test("chipText formats compact and detailed modes for claude, agy, and empty states", () => {
  const now = 1_700_000_000_000;
  const resets3h12m = now + 3 * 3_600_000 + 12 * 60_000;
  const resets2d4h = now + 2 * 86_400_000 + 4 * 3_600_000;

  assert.equal(chipText(null, "compact", now), "···");
  assert.equal(chipText({}, "compact", now), "···");
  assert.equal(chipText({ status: "ok", windows: [] }, "compact", now), "--");
  assert.equal(chipText({ status: "error", windows: [] }, "compact", now), "");

  const claude = {
    status: "ok",
    windows: [
      { label: "5h", minutes: 300, usedPercent: 42.4, resetsAt: resets3h12m },
      { label: "Weekly", minutes: 10080, usedPercent: 18, resetsAt: resets2d4h },
    ],
  };
  assert.equal(chipText(claude, "compact", now), "42% 3h 12m");
  assert.equal(chipText(claude, "detailed", now), "42% 3h 12m · 18% 2d 4h");

  const agy = {
    status: "ok",
    windows: [
      { label: "Gemini 3.1 Pro Models · 5h", minutes: 300, usedPercent: 25, resetsAt: resets3h12m },
      { label: "Gemini 3.1 Pro Models · Weekly", minutes: 10080, usedPercent: 60, resetsAt: null },
      { label: "Fable · 5h", minutes: 300, usedPercent: 60, resetsAt: null },
    ],
  };
  assert.equal(chipText(agy, "compact", now), "60% Gemini 3.1 Pro wk");
  assert.equal(
    chipText(agy, "detailed", now),
    "25% 3h 12m · 60% Gemini 3.1 Pro wk · 60% Fable 5h"
  );

  const agyCustomMinutes = {
    status: "ok",
    windows: [{ label: "Flash Models · Daily", minutes: 1440, usedPercent: 12, resetsAt: null }],
  };
  assert.equal(chipText(agyCustomMinutes, "compact", now), "12% Flash");
  assert.equal(chipText(agyCustomMinutes, "detailed", now), "12% Flash");
});

test("windowName maps window labels and durations to display names", () => {
  assert.equal(windowName({ label: "Fable", minutes: 300 }), "Fable");
  assert.equal(windowName({ label: "5h", minutes: 300 }), "Session");
  assert.equal(windowName({ label: "7d", minutes: 10080 }), "Weekly");
  assert.equal(windowName({ label: "Gemini 3.1 Pro", minutes: 0 }), "Gemini 3.1 Pro");
});

test("updatedText formats relative fetch timestamps", () => {
  const now = 1_700_000_000_000;
  assert.equal(updatedText(null, now), "Not updated yet");
  assert.equal(updatedText(0, now), "Not updated yet");
  assert.equal(updatedText(now - 10_000, now), "Updated just now");
  assert.equal(updatedText(now - 59_999, now), "Updated just now");
  assert.equal(updatedText(now - 60_000, now), "Updated 1m ago");
  assert.equal(updatedText(now - 3_599_000, now), "Updated 59m ago");
  assert.equal(updatedText(now - 3_600_000, now), "Updated 1h ago");
  assert.equal(updatedText(now - 7_200_000, now), "Updated 2h ago");
});
