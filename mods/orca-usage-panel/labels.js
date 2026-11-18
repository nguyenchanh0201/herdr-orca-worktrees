import { until } from "./format.js";

export const DISPLAY_NAMES = {
  claude: "Claude",
  codex: "Codex",
  agy: "Antigravity",
};

export function providerName(id) {
  return DISPLAY_NAMES[id] ?? id;
}

export function resetLabel(resetsAt, now) {
  if (resetsAt == null) return "";
  const u = until(resetsAt, now);
  if (u === "now") return "Resets now";
  return u ? `Resets in ${u}` : "";
}
