const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitInfo } = require("./git-info");
const YAML = require("yaml");

function herdrHome() {
  return process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
}

function ownerFromRemote(remote) {
  if (typeof remote !== "string" || !remote.trim()) return null;
  const scp = remote.match(/^(?:[^@\s/]+@)?(github[^:\s/]*):([^\s]+)$/i);
  let host, repoPath;
  if (scp && !remote.includes("://")) {
    [, host, repoPath] = scp;
  } else {
    try {
      const url = new URL(remote);
      if (!["https:", "http:", "ssh:"].includes(url.protocol)) return null;
      host = url.hostname;
      repoPath = url.pathname.slice(1);
    } catch {
      return null;
    }
  }
  if (!/^github/i.test(host)) return null;
  const match = repoPath.match(/^([a-z\d-]+)\/[^/\s]+\/?$/i);
  return match ? match[1] : null;
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

const REPO_ICON_CANDIDATES = [
  "favicon", "public/favicon", "app/favicon", "app/icon", "src/favicon",
  "src/app/icon", "assets/favicon", "assets/icon", "static/favicon", "logo",
  "public/logo", "public/icon", "src-tauri/icons/icon", "app-icon", "icon",
].flatMap((name) => [`${name}.png`, `${name}.webp`]);

function githubLogins() {
  try {
    const dir = process.env.GH_CONFIG_DIR || path.join(os.homedir(), ".config", "gh");
    const hosts = YAML.parse(fs.readFileSync(path.join(dir, "hosts.yml"), "utf8"));
    const logins = new Set();
    for (const host of Object.values(hosts)) {
      if (host?.users && typeof host.users === "object") {
        for (const login of Object.keys(host.users)) logins.add(login);
      }
      if (typeof host?.user === "string") logins.add(host.user);
    }
    return [...logins];
  } catch {
    return [];
  }
}

function savedIconFile(icon) {
  if (!icon || icon.source === "letter" || typeof icon.file !== "string" || path.isAbsolute(icon.file)) return null;
  try {
    const home = fs.realpathSync(herdrHome());
    const file = fs.realpathSync(path.join(home, icon.file));
    const relative = path.relative(home, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 262144) return null;
    const bytes = fs.readFileSync(file);
    return bytes.length <= 262144 && sniffImage(bytes) ? icon.file : null;
  } catch {
    return null;
  }
}

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
      name: p.name || null,
      icon: savedIconFile(p.icon),
      iconSource: p.icon?.source || null,
    })),
    seeded: true,
  };
}

function renameProject(targetPath, name = "") {
  const state = readProjectsFile();
  if (state.error) return { error: state.error };
  const entry = state.projects.find((p) => p.path === targetPath);
  if (!entry) return { error: "Project is not saved" };
  const trimmed = name.trim();
  if (trimmed) entry.name = trimmed;
  else delete entry.name;
  writeProjectsAtomic(state.projects);
  return { path: entry.path, name: trimmed || null };
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
  herdrHome,
  ownerFromRemote,
  sniffImage,
  REPO_ICON_CANDIDATES,
  renameProject,
  githubLogins,
  stateDir,
  listProjects,
  addProject,
  removeProject,
  seedProjects,
  defaultCloneName,
  cloneProject,
};
