const { spawn } = require("node:child_process");

function parseResetsAt(v) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e10 ? v : v * 1000;
  }
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function mapWindow(raw, slotLabel, slotMinutes) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.usedPercent !== "number" || !Number.isFinite(raw.usedPercent)) return null;

  const mins = raw.windowDurationMins;
  let label = slotLabel;
  let minutes = slotMinutes;
  if (typeof mins === "number" && Number.isFinite(mins)) {
    if (Math.abs(mins - 300) <= 1) {
      label = "5h";
      minutes = 300;
    } else if (Math.abs(mins - 10080) <= 1) {
      label = "Weekly";
      minutes = 10080;
    }
  }

  return {
    label,
    minutes,
    usedPercent: Math.round(raw.usedPercent),
    resetsAt: parseResetsAt(raw.resetsAt),
  };
}

function mapCodexLimits(result) {
  const limits = result && result.rateLimits;
  if (!limits || typeof limits !== "object") return [];

  const windows = [];
  const primary = mapWindow(limits.primary, "5h", 300);
  if (primary) windows.push(primary);
  const secondary = mapWindow(limits.secondary, "Weekly", 10080);
  if (secondary) windows.push(secondary);
  return windows;
}

function isAuthError(message) {
  if (typeof message !== "string") return false;
  return /auth|login|logged in|signed in|sign in|unauthorized|not authenticated/i.test(message);
}

function makeProvider(status, { error, windows = [], fetchedAt }) {
  const out = { id: "codex", status, windows, fetchedAt };
  if (error !== undefined) out.error = error;
  return out;
}

async function fetchCodex({
  command = "codex",
  env = process.env,
  timeouts = { init: 30000, read: 10000 },
  now = Date.now(),
} = {}) {
  const initTimeout = timeouts.init ?? 30000;
  const readTimeout = timeouts.read ?? 10000;

  let child;
  try {
    child = spawn(
      command,
      ["-c", "approval_policy=never", "-c", "features.plugins=false", "-s", "read-only", "-a", "never", "app-server"],
      { env, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return makeProvider("unavailable", { error: "Not installed", fetchedAt: now });
    }
    return makeProvider("error", { error: "Codex did not answer", fetchedAt: now });
  }

  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let buffer = "";

      const finish = (provider) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(provider);
      };

      const startTimer = (ms) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          finish(makeProvider("error", { error: "Codex did not answer", fetchedAt: now }));
        }, ms);
      };

      child.on("error", (err) => {
        if (err && err.code === "ENOENT") {
          finish(makeProvider("unavailable", { error: "Not installed", fetchedAt: now }));
        } else {
          finish(makeProvider("error", { error: "Codex did not answer", fetchedAt: now }));
        }
      });

      child.on("exit", () => {
        finish(makeProvider("error", { error: "Codex did not answer", fetchedAt: now }));
      });

      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;

          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }

          if (msg.id === 1) {
            if (msg.error) {
              const errMsg = msg.error.message || "Codex error";
              if (isAuthError(errMsg)) {
                finish(makeProvider("unavailable", { error: "Not signed in", fetchedAt: now }));
              } else {
                finish(makeProvider("error", { error: errMsg, fetchedAt: now }));
              }
              return;
            }
            startTimer(readTimeout);
            child.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n"
            );
            child.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} }) + "\n"
            );
          } else if (msg.id === 2) {
            if (msg.error) {
              const errMsg = msg.error.message || "Codex error";
              if (isAuthError(errMsg)) {
                finish(makeProvider("unavailable", { error: "Not signed in", fetchedAt: now }));
              } else {
                finish(makeProvider("error", { error: errMsg, fetchedAt: now }));
              }
              return;
            }
            finish(makeProvider("ok", { windows: mapCodexLimits(msg.result), fetchedAt: now }));
          }
        }
      });

      startTimer(initTimeout);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "orca-wt", version: "1.0.0" } },
        }) + "\n"
      );
    });

    return result;
  } finally {
    if (child && !child.killed) {
      child.kill();
    }
  }
}

module.exports = {
  mapCodexLimits,
  fetchCodex,
};
