const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const SIGNED_OUT_PHRASES = [
  "not logged into antigravity",
  "not logged in",
  "not signed in",
  "not authenticated",
  "not-authenticated",
  "unauthenticated",
  "run agy login",
  "please sign in",
  "please log in",
  "sign in to antigravity",
  "no credentials",
  "authentication required",
];

function parseVersion(v) {
  if (typeof v !== "string") return null;
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(v, min = "1.1.11") {
  const actual = parseVersion(v);
  const target = parseVersion(min);
  if (!actual || !target) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] > target[i]) return true;
    if (actual[i] < target[i]) return false;
  }
  return true;
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

function parseAgyUsage(stdout = "", stderr = "") {
  const objects = [];
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      objects.push(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }

  const usageObj = objects.find((o) => o && o.command && o.command.name === "usage");
  if (usageObj) {
    if (usageObj.status === "SUCCESS") {
      const windows = [];
      const groups = Array.isArray(usageObj.groups) ? usageObj.groups : [];
      for (const group of groups) {
        if (!group || typeof group !== "object") continue;
        const buckets = Array.isArray(group.buckets) ? group.buckets : [];
        const multi = buckets.length > 1;
        for (const bucket of buckets) {
          if (!bucket || bucket.disabled) continue;
          if (typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction)) {
            continue;
          }
          const usedPercent = Math.round((1 - bucket.remaining_fraction) * 100);
          const minutes = bucket.window === "weekly" ? 10080 : bucket.window === "5h" ? 300 : 0;
          const label = multi && bucket.name ? `${group.name} · ${bucket.name}` : group.name;
          windows.push({
            label,
            minutes,
            usedPercent,
            resetsAt: parseResetsAt(bucket.reset_time),
          });
        }
      }
      return { windows };
    }
    if (usageObj.status === "ERROR") {
      return { error: usageObj.error || "Couldn't read agy usage" };
    }
  }

  const hasModelTurn = objects.some(
    (o) => o && ((typeof o.num_turns === "number" && o.num_turns > 0) || Boolean(o.conversation_id))
  );
  if (hasModelTurn) {
    return { stopAsking: true };
  }

  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (SIGNED_OUT_PHRASES.some((phrase) => combined.includes(phrase))) {
    return { signedOut: true };
  }

  return { error: "Couldn't read agy usage" };
}

async function fetchAgy({ command = "agy", env = process.env, now = Date.now() } = {}) {
  let versionOut = "";
  try {
    const res = await execFileAsync(command, ["--version"], { env, timeout: 10000 });
    versionOut = res.stdout || "";
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        id: "agy",
        status: "unavailable",
        error: "Not installed",
        windows: [],
        fetchedAt: now,
      };
    }
    return {
      id: "agy",
      status: "error",
      error: "Couldn't read agy usage",
      windows: [],
      fetchedAt: now,
    };
  }

  if (!versionAtLeast(versionOut, "1.1.11")) {
    return {
      id: "agy",
      status: "unavailable",
      error: "Update agy to show usage",
      windows: [],
      fetchedAt: now,
    };
  }

  let stdout = "";
  let stderr = "";
  try {
    const res = await execFileAsync(
      command,
      ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"],
      {
        env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
        timeout: 30000,
      }
    );
    stdout = res.stdout || "";
    stderr = res.stderr || "";
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return {
        id: "agy",
        status: "unavailable",
        error: "Not installed",
        windows: [],
        fetchedAt: now,
      };
    }
    stdout = (err && err.stdout) || "";
    stderr = (err && err.stderr) || "";
  }

  const parsed = parseAgyUsage(stdout, stderr);
  if (parsed.windows) {
    return {
      id: "agy",
      status: "ok",
      windows: parsed.windows,
      fetchedAt: now,
    };
  }
  if (parsed.stopAsking) {
    return {
      id: "agy",
      status: "unavailable",
      error: "agy doesn't support /usage",
      stopAsking: true,
      windows: [],
      fetchedAt: now,
    };
  }
  if (parsed.signedOut) {
    return {
      id: "agy",
      status: "unavailable",
      error: "Sign in with agy",
      manualOnly: true,
      windows: [],
      fetchedAt: now,
    };
  }
  return {
    id: "agy",
    status: "error",
    error: parsed.error || "Couldn't read agy usage",
    windows: [],
    fetchedAt: now,
  };
}

module.exports = {
  versionAtLeast,
  parseAgyUsage,
  fetchAgy,
};
