const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitInfo } = require("./git-info");

function stateDir() {
  return process.env.ORCA_WT_STATE_DIR || path.join(os.homedir(), ".local", "state", "orca-worktrees");
}

function projectsFilePath() {
  return path.join(stateDir(), "projects.json");
}

function readProjectsFile() {
  const file = projectsFilePath();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { missing: true, projects: [] };
    }
    return { error: err && err.message ? err.message : String(err) };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { error: err && err.message ? err.message : "Invalid JSON", corrupt: true };
  }

  if (!data || typeof data !== "object" || !Array.isArray(data.projects)) {
    return { error: "Invalid projects.json format", corrupt: true };
  }

  return { projects: data.projects };
}

function writeProjectsAtomic(projects) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "projects.json");
  const tmp = path.join(dir, "projects.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, projects }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function moveBadFileAside() {
  const file = projectsFilePath();
  const bad = path.join(stateDir(), `projects.json.bad-${Date.now()}`);
  fs.renameSync(file, bad);
}

function listProjects() {
  const state = readProjectsFile();
  if (state.missing) {
    return { projects: [], seeded: false };
  }
  if (state.error) {
    return { error: state.error };
  }
  return {
    projects: state.projects.map((p) => ({
      path: p.path,
      exists: fs.existsSync(p.path),
    })),
    seeded: true,
  };
}

function addProject(folder) {
  const info = gitInfo(folder);
  if (!info) {
    return { error: "Not a git repository" };
  }

  const primary = fs.realpathSync(info.primary);
  const state = readProjectsFile();

  let projects;
  if (state.missing) {
    projects = [];
  } else if (state.corrupt) {
    moveBadFileAside();
    projects = [];
  } else if (state.error) {
    return { error: state.error };
  } else {
    projects = state.projects;
  }

  if (projects.some((p) => p.path === primary)) {
    return { path: primary, added: false };
  }

  writeProjectsAtomic([...projects, { path: primary }]);
  return { path: primary, added: true };
}

function removeProject(targetPath) {
  if (!targetPath) {
    return { removed: false };
  }

  let resolved = targetPath;
  try {
    resolved = fs.realpathSync(targetPath);
  } catch {
    resolved = targetPath;
  }

  const state = readProjectsFile();
  if (state.missing) {
    return { removed: false };
  }
  if (state.corrupt) {
    moveBadFileAside();
    writeProjectsAtomic([]);
    return { removed: false };
  }
  if (state.error) {
    return { error: state.error };
  }

  const next = state.projects.filter((p) => p.path !== resolved && p.path !== targetPath);
  if (next.length === state.projects.length) {
    return { removed: false };
  }

  writeProjectsAtomic(next);
  return { removed: true };
}

function seedProjects(paths) {
  if (fs.existsSync(projectsFilePath())) {
    const state = readProjectsFile();
    return {
      seeded: false,
      projects: state.projects ? state.projects.map((p) => p.path) : [],
    };
  }

  const seen = new Set();
  const unique = [];
  for (const p of paths || []) {
    const info = gitInfo(p);
    if (!info) continue;
    const primary = fs.realpathSync(info.primary);
    if (seen.has(primary)) continue;
    seen.add(primary);
    unique.push(primary);
  }

  writeProjectsAtomic(unique.map((p) => ({ path: p })));
  return { seeded: true, projects: unique };
}

function defaultCloneName(url) {
  if (typeof url !== "string") return "";
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const seg = trimmed.split(/[/:]/).pop() || "";
  return seg.replace(/\.git$/i, "");
}

function tailLines(text, maxLines = 20) {
  if (!text) return "";
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

function cloneProject(url, parent, name) {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { error: "Git URL is required" };
  }
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    return { error: "Invalid folder name" };
  }

  let isDir = false;
  try {
    isDir = Boolean(parent) && fs.statSync(parent).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { error: `Parent directory does not exist: ${parent}` };
  }

  const dest = path.join(parent, name);
  if (fs.existsSync(dest)) {
    return { error: `${dest} already exists` };
  }

  const r = spawnSync("git", ["clone", "--", url.trim(), dest], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
    timeout: 590000,
    encoding: "utf8",
  });

  if (r.error || r.status !== 0) {
    const errText =
      tailLines(r.stderr) ||
      (r.error && r.error.message) ||
      tailLines(r.stdout) ||
      "git clone failed";
    return { error: errText };
  }

  const added = addProject(dest);
  if (added.error) {
    return { error: added.error };
  }
  return { path: added.path };
}

module.exports = {
  stateDir,
  listProjects,
  addProject,
  removeProject,
  seedProjects,
  defaultCloneName,
  cloneProject,
};
