// Pure CJS twin of mods/projects/sleep.js for sleep/wake command parsing,
// plus Node-only sleep record & Codex session helpers for bin/orca-wt.js.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitInfo } = require("./git-info");

const SLEEP_FILE = "orca-sleep.json";

const KIND_MAP = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  agy: "agy",
  antigravity: "agy",
  "dsh-tui": "dsh",
};

const QUIT = {
  claude: "/exit",
  codex: "/quit",
  agy: "/quit",
  dsh: "/exit",
};

const RESUME_PATTERNS = {
  codex: /^codex resume [0-9a-f-]{8,}$/,
  agy: /^agy --conversation=[A-Za-z0-9-]+$/,
  dsh: /^DSH_TUI_RESUME_SESSION=[A-Za-z0-9-]+ dsh --profile dsh-tui$/,
  claude: /^claude (--resume|-r) [A-Za-z0-9-]+$/,
};

const FALLBACK_PATTERNS = {
  agy: /^agy --continue$/,
  dsh: /^dsh-tui --continue$/,
};

const KEPT_FLAG_SPECS = {
  codex: { bool: new Set(["--no-daemon"]), value: new Set() },
  claude: {
    bool: new Set(["--dangerously-skip-permissions"]),
    value: new Set(["--permission-mode", "--model", "--effort"]),
  },
  agy: {
    bool: new Set(),
    value: new Set(["--mode", "--model", "--effort"]),
  },
  dsh: { bool: new Set(), value: new Set() },
};

// Matches OSC (BEL or ST terminated), DCS/APC/PM/SOS, CSI, and 2-byte ESC sequences.
const ANSI_RE =
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]+[@-~]|\x1b[@-Z\\-_]/g;

/** Map a Herdr agent object to its sleep kind ("claude" | "codex" | "agy" | "dsh" | null). */
function agentKind(agent) {
  if (!agent) return null;
  return KIND_MAP[agent.app] ?? KIND_MAP[agent.program?.key] ?? null;
}

/** Strip ANSI escape sequences from terminal text. */
function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text.replace(ANSI_RE, "");
}

/** Scan terminal screen text bottom-up for a full-line resume command for kind. */
function parseResume(kind, screen) {
  const pattern = RESUME_PATTERNS[kind];
  if (!pattern || typeof screen !== "string") return null;
  const lines = stripAnsi(screen).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (pattern.test(line)) return line;
  }
  return null;
}

/** Build a fallback resume command when the exit screen didn't print one. */
function fallbackResume(kind, opts = {}) {
  const { claudeSessionId, codexSessionId } = opts || {};
  if (kind === "claude") return claudeSessionId ? `claude --resume ${claudeSessionId}` : null;
  if (kind === "codex") return codexSessionId ? `codex resume ${codexSessionId}` : null;
  if (kind === "agy") return "agy --continue";
  if (kind === "dsh") return "dsh-tui --continue";
  return null;
}

/** Extract launch flags worth preserving across sleep/wake from foreground argv. */
function keptFlags(kind, argv) {
  const spec = KEPT_FLAG_SPECS[kind];
  if (!spec || !Array.isArray(argv) || argv.length === 0) return [];
  const start = typeof argv[0] === "string" && argv[0].startsWith("-") ? 0 : 1;
  const out = [];
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (spec.bool.has(arg)) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0 && spec.value.has(arg.slice(0, eq))) {
      out.push(arg);
      continue;
    }
    if (spec.value.has(arg) && i + 1 < argv.length && typeof argv[i + 1] === "string") {
      out.push(arg, argv[i + 1]);
      i++;
    }
  }
  return out;
}

/** Insert kept flags right after the program word (unless dsh or env-prefixed). */
function withFlags(kind, command, flags) {
  if (!command || !Array.isArray(flags) || flags.length === 0 || kind === "dsh") {
    return command;
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0].includes("=")) return command;
  return [parts[0], ...flags, ...parts.slice(1)].join(" ");
}

/** Convert a resume command string into an argv array, wrapping env vars with `env`. */
function resumeArgv(command) {
  if (typeof command !== "string") return [];
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts[0].includes("=")) return ["env", ...parts];
  return parts;
}

/** Validate that a resume string matches either the exit-screen pattern or fallback shape for kind. */
function isValidResume(kind, resume) {
  if (typeof resume !== "string") return false;
  const pattern = RESUME_PATTERNS[kind];
  if (!pattern) return false;
  if (pattern.test(resume)) return true;
  const fallback = FALLBACK_PATTERNS[kind];
  return fallback ? fallback.test(resume) : false;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "elvish"]);

/** Return true if argv0's basename (stripping leading '-') is a known interactive shell. */
function isShellArgv(argv0) {
  if (typeof argv0 !== "string" || !argv0) return false;
  const base = argv0.split(/[/\\]/).pop() || "";
  const name = base.startsWith("-") ? base.slice(1) : base;
  return SHELLS.has(name);
}

/** Return true when a terminal's foreground process has exited back to a shell or changed pid. */
function agentExited(before, after) {
  if (!after?.foreground) return true;
  if (isShellArgv(after.foreground.argv?.[0])) return true;
  if (before?.foreground?.pid != null && after.foreground.pid !== before.foreground.pid) return true;
  return false;
}

function gitDirOf(worktree) {
  const info = gitInfo(worktree);
  return info ? info.gitDir : null;
}

function validateSleepRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return "Record must be an object";
  }
  if (record.version !== 1) return "Record version must be 1";
  if (typeof record.sleptAt !== "number" || !Number.isFinite(record.sleptAt)) {
    return "Record sleptAt must be a finite number";
  }
  if (record.branch !== undefined && record.branch !== null && typeof record.branch !== "string") {
    return "Record branch must be a string or null";
  }
  if (!Array.isArray(record.agents) || record.agents.length === 0) {
    return "Record agents must be a non-empty array";
  }
  for (const agent of record.agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      return "Each agent must be an object";
    }
    if (typeof agent.kind !== "string" || !isValidResume(agent.kind, agent.resume)) {
      return "Agent resume is invalid";
    }
    if (typeof agent.command !== "string" || !agent.command.trim()) {
      return "Agent command is required";
    }
    if (typeof agent.cwd !== "string" || !agent.cwd) {
      return "Agent cwd is required";
    }
    if (typeof agent.name !== "string" || !agent.name) {
      return "Agent name is required";
    }
    if (agent.terminal !== undefined && typeof agent.terminal !== "string") {
      return "Agent terminal must be a string";
    }
    if (agent.tab !== undefined && agent.tab !== null && typeof agent.tab !== "string") {
      return "Agent tab must be a string or null";
    }
    if (agent.flags !== undefined && !Array.isArray(agent.flags)) {
      return "Agent flags must be an array";
    }
  }
  return null;
}

/** Validate and atomically write a sleep record into the worktree's git dir. */
function saveSleep(worktree, record) {
  const gitDir = gitDirOf(worktree);
  if (!gitDir) return { error: "Not a git repository" };

  const err = validateSleepRecord(record);
  if (err) return { error: err };

  const file = path.join(gitDir, SLEEP_FILE);
  const tmp = path.join(gitDir, `${SLEEP_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, file };
}

/** Read a worktree's sleep record, or return null if missing/unreadable. */
function getSleep(worktree) {
  const gitDir = gitDirOf(worktree);
  if (!gitDir) return null;
  try {
    const raw = fs.readFileSync(path.join(gitDir, SLEEP_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Remove a worktree's sleep record (no-op if missing). */
function clearSleep(worktree) {
  const gitDir = gitDirOf(worktree);
  if (!gitDir) return { cleared: false };
  fs.rmSync(path.join(gitDir, SLEEP_FILE), { force: true });
  return { cleared: true };
}

/** List all sleeping worktrees (including main checkouts) across the given repos. */
function listSleep(repos) {
  const result = {};
  if (!Array.isArray(repos)) return result;

  for (const repo of repos) {
    if (typeof repo !== "string" || !repo) continue;
    const r = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
    });
    if (r.status !== 0) continue;

    let realRepo = repo;
    try {
      realRepo = fs.realpathSync(repo);
    } catch {
      // Keep original path if realpath fails.
    }

    for (const rawLine of (r.stdout || "").split(/\r?\n/)) {
      if (!rawLine.startsWith("worktree ")) continue;
      let wt = rawLine.slice("worktree ".length);
      try {
        wt = fs.realpathSync(wt);
      } catch {
        continue;
      }
      const rec = getSleep(wt);
      if (rec) result[wt] = { ...rec, repo: realRepo };
    }
  }
  return result;
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const buf = Buffer.allocUnsafe(16384);
    let total = 0;
    while (total < 262144) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Find the newest Codex session ID matching cwd at or after sinceMs. */
function codexSession(cwd, sinceMs, sessionsDir = path.join(os.homedir(), ".codex", "sessions")) {
  if (typeof cwd !== "string" || !cwd || !Number.isFinite(sinceMs)) return { id: null };

  let bestTs = -Infinity;
  let bestId = null;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const line = readFirstLine(full).trim();
          if (!line) continue;
          const parsed = JSON.parse(line);
          const payload = parsed && parsed.payload;
          if (!payload || payload.cwd !== cwd) continue;
          const ts = Date.parse(payload.timestamp);
          if (!Number.isFinite(ts) || ts < sinceMs) continue;
          if (typeof payload.id === "string" && payload.id && ts > bestTs) {
            bestTs = ts;
            bestId = payload.id;
          }
        } catch {
          // Ignore unreadable or malformed session files.
        }
      }
    }
  }

  walk(sessionsDir);
  return { id: bestId };
}

module.exports = {
  agentKind,
  QUIT,
  stripAnsi,
  parseResume,
  fallbackResume,
  keptFlags,
  withFlags,
  resumeArgv,
  isValidResume,
  isShellArgv,
  agentExited,
  saveSleep,
  getSleep,
  clearSleep,
  listSleep,
  codexSession,
};
