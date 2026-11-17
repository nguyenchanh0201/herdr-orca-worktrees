// Pure, import-free sleep/wake command parsing for the projects sidebar mod.

const KIND_MAP = {
  "claude-code": "claude",
  claude: "claude",
  codex: "codex",
  agy: "agy",
  antigravity: "agy",
  "dsh-tui": "dsh",
};

export const QUIT = {
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
export function agentKind(agent) {
  if (!agent) return null;
  return KIND_MAP[agent.app] ?? KIND_MAP[agent.program?.key] ?? null;
}

/** Strip ANSI escape sequences from terminal text. */
export function stripAnsi(text) {
  if (typeof text !== "string") return "";
  return text.replace(ANSI_RE, "");
}

/** Scan terminal screen text bottom-up for a full-line resume command for kind. */
export function parseResume(kind, screen) {
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
export function fallbackResume(kind, opts = {}) {
  const { claudeSessionId, codexSessionId } = opts || {};
  if (kind === "claude") return claudeSessionId ? `claude --resume ${claudeSessionId}` : null;
  if (kind === "codex") return codexSessionId ? `codex resume ${codexSessionId}` : null;
  if (kind === "agy") return "agy --continue";
  if (kind === "dsh") return "dsh-tui --continue";
  return null;
}

/** Extract launch flags worth preserving across sleep/wake from foreground argv. */
export function keptFlags(kind, argv) {
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

const FULL_ACCESS = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  agy: ["--dangerously-skip-permissions"],
};

/** Full-access flags for kind that are missing from existing (DeepSeek TUI has none). */
export function fullAccessFlags(kind, existing) {
  const have = Array.isArray(existing) ? existing : [];
  return (FULL_ACCESS[kind] ?? []).filter((f) => !have.includes(f));
}

/** hc reports a finished-but-unseen turn as "done"; it waits at the prompt just like "idle". */
export function atPrompt(state) {
  return state === "idle" || state === "done";
}

/** Insert kept flags right after the program word (unless dsh or env-prefixed). */
export function withFlags(kind, command, flags) {
  if (!command || !Array.isArray(flags) || flags.length === 0 || kind === "dsh") {
    return command;
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0].includes("=")) return command;
  return [parts[0], ...flags, ...parts.slice(1)].join(" ");
}

/** Convert a resume command string into an argv array, wrapping env vars with `env`. */
export function resumeArgv(command) {
  if (typeof command !== "string") return [];
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts[0].includes("=")) return ["env", ...parts];
  return parts;
}

/** Validate that a resume string matches either the exit-screen pattern or fallback shape for kind. */
export function isValidResume(kind, resume) {
  if (typeof resume !== "string") return false;
  const pattern = RESUME_PATTERNS[kind];
  if (!pattern) return false;
  if (pattern.test(resume)) return true;
  const fallback = FALLBACK_PATTERNS[kind];
  return fallback ? fallback.test(resume) : false;
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "elvish"]);

/** Return true if argv0's basename (stripping leading '-') is a known interactive shell. */
export function isShellArgv(argv0) {
  if (typeof argv0 !== "string" || !argv0) return false;
  const base = argv0.split(/[/\\]/).pop() || "";
  const name = base.startsWith("-") ? base.slice(1) : base;
  return SHELLS.has(name);
}

/** Return true when a terminal's foreground process has exited back to a shell or changed pid. */
export function agentExited(before, after) {
  if (!after?.foreground) return true;
  if (isShellArgv(after.foreground.argv?.[0])) return true;
  if (before?.foreground?.pid != null && after.foreground.pid !== before.foreground.pid) return true;
  return false;
}
