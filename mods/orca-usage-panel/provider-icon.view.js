import { icon } from "./ui/atoms/icon.js";

// A provider's icon, or null while the agent icons are still loading. `tone` is a theme color key.
export function providerIcon(view, id, tone, size = "lg") {
  const ic = view.icons[id];
  if (!ic?.icon) return null;
  return icon(ic.icon, { size, tone, tint: ic.tint });
}
