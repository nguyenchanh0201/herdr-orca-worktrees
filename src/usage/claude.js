const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function keychainCandidates(env = process.env) {
  const dir = env && env.CLAUDE_CONFIG_DIR;
  if (dir) {
    const hash = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8);
    return [`Claude Code-credentials-${hash}`, "Claude Code-credentials"];
  }
  return ["Claude Code-credentials"];
}

function keychainAccount(user) {
  return typeof user === "string" && /^[a-zA-Z0-9._-]+$/.test(user)
    ? user
    : "claude-code-user";
}

function parseResetsAt(v) {
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e10 ? v : v * 1000;
  }
  return null;
}

function toWindow(raw, label, minutes, includePercent = false) {
  if (!raw || typeof raw !== "object") return null;
  const pct = includePercent
    ? raw.percent ?? raw.utilization ?? raw.used_percentage
    : raw.utilization ?? raw.used_percentage;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  return {
    label,
    minutes,
    usedPercent: Math.round(pct),
    resetsAt: parseResetsAt(raw.resets_at),
  };
}

function mapClaudeUsage(json) {
  if (!json || typeof json !== "object") return [];
  const windows = [];

  const fiveHour = toWindow(json.five_hour, "5h", 300);
  if (fiveHour) windows.push(fiveHour);

  const sevenDay = toWindow(json.seven_day, "Weekly", 10080);
  if (sevenDay) windows.push(sevenDay);

  let fableRaw = null;
  let fableFromLimits = false;
  if (Array.isArray(json.limits)) {
    const entry = json.limits.find(
      (item) =>
        item &&
        item.kind === "weekly_scoped" &&
        item.scope &&
        item.scope.model &&
        typeof item.scope.model.display_name === "string" &&
        item.scope.model.display_name.toLowerCase() === "fable"
    );
    if (entry) {
      fableRaw = entry;
      fableFromLimits = true;
    }
  }
  if (!fableRaw) {
    fableRaw = json.fable_weekly || json.fable_seven_day || json.seven_day_fable || null;
  }
  const fable = toWindow(fableRaw, "Fable", 10080, fableFromLimits);
  if (fable) windows.push(fable);

  return windows;
}

function defaultReadSecret(service, account) {
  const res = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" }
  );
  if (res.status === 44) return { ok: false, missing: true };
  if (res.status === 0) return { ok: true, value: (res.stdout || "").trim() };
  return { ok: false, missing: false };
}

function defaultReadFile(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function extractToken(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const tok =
        (parsed && parsed.claudeAiOauth && parsed.claudeAiOauth.accessToken) ||
        (parsed && parsed.accessToken) ||
        (parsed && parsed.token);
      return typeof tok === "string" && tok.trim() ? tok.trim() : null;
    } catch {
      return null;
    }
  }
  return trimmed;
}

function redactToken(msg, token) {
  const text = String(msg);
  return token ? text.split(token).join("[redacted]") : text;
}

async function fetchClaude({
  readSecret = defaultReadSecret,
  readFile = defaultReadFile,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now(),
} = {}) {
  const account = keychainAccount(env.USER);
  let token = null;

  for (const service of keychainCandidates(env)) {
    const res = await readSecret(service, account);
    if (res && res.ok) {
      token = extractToken(res.value);
      if (token) break;
    } else if (res && !res.missing) {
      return {
        id: "claude",
        status: "error",
        error: "Allow keychain access for Claude usage",
        windows: [],
        fetchedAt: now,
      };
    }
  }

  if (!token) {
    const home = env.HOME || os.homedir();
    const credPath = path.join(home, ".claude", ".credentials.json");
    token = extractToken(await readFile(credPath));
  }

  if (!token) {
    return {
      id: "claude",
      status: "unavailable",
      error: "Not signed in",
      windows: [],
      fetchedAt: now,
    };
  }

  try {
    const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        id: "claude",
        status: "error",
        error: "Updates the next time Claude runs",
        windows: [],
        fetchedAt: now,
      };
    }
    if (res.status === 429) {
      return {
        id: "claude",
        status: "error",
        error: "Rate limited",
        windows: [],
        fetchedAt: now,
      };
    }
    if (!res.ok) {
      return {
        id: "claude",
        status: "error",
        error: `HTTP ${res.status}`,
        windows: [],
        fetchedAt: now,
      };
    }

    const json = await res.json();
    return {
      id: "claude",
      status: "ok",
      windows: mapClaudeUsage(json),
      fetchedAt: now,
    };
  } catch (err) {
    const msg = err && err.message ? err.message : err;
    return {
      id: "claude",
      status: "error",
      error: redactToken(msg, token),
      windows: [],
      fetchedAt: now,
    };
  }
}

module.exports = {
  keychainCandidates,
  keychainAccount,
  mapClaudeUsage,
  fetchClaude,
};
