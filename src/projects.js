const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitInfo } = require("./git-info");
const YAML = require("yaml");
const { createHash } = require("node:crypto");

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
  if (buf.length >= 12 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) return "webp";
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
  if (!icon || icon.source === "letter" || typeof icon.file !== "string") return null;
  // Stored data: only accept files inside the icon cache.
  if (!/^data\/project-icons\/[^/]+$/.test(icon.file)) return null;
  try {
    const bytes = fs.readFileSync(path.join(herdrHome(), icon.file));
    return bytes.length <= MAX_ICON_BYTES && sniffImage(bytes) ? icon.file : null;
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
      group: typeof p.group === "string" && p.group.trim() ? p.group.trim() : null,
    })),
    seeded: true,
  };
}

const MAX_ICON_BYTES = 262144;
let lastIconVersion = 0;

function projectHash(targetPath) {
  return createHash("sha1").update(targetPath).digest("hex");
}

function localIcon(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_ICON_BYTES) throw new Error("Icon must be a file at most 262144 bytes");
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_ICON_BYTES || !sniffImage(bytes)) throw new Error("Not a supported image");
  return bytes;
}

function repoIcon(targetPath) {
  for (const candidate of REPO_ICON_CANDIDATES) {
    try { return localIcon(path.join(targetPath, candidate)); } catch { /* Try the next candidate. */ }
  }
  return null;
}

function projectOwner(targetPath) {
  const result = spawnSync("git", ["-C", targetPath, "remote", "get-url", "origin"], { encoding: "utf8" });
  return result.status === 0 ? ownerFromRemote(result.stdout.trim()) : null;
}

async function downloadIcon(url, fetchImpl, avatar = false) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Icon download failed");
  if (Number(response.headers.get("content-length")) > MAX_ICON_BYTES) throw new Error("Icon exceeds 262144 bytes");
  // Read in chunks so an endless or huge body stops at the cap instead of filling memory.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_ICON_BYTES) throw new Error("Icon exceeds 262144 bytes");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  const ext = sniffImage(bytes);
  if (!ext || (avatar && ext === "webp")) throw new Error("Not a supported image");
  return bytes;
}

function iconCache() {
  const dir = path.join(herdrHome(), "data", "project-icons");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeIcon(targetPath, source, bytes) {
  // Unique per write even within one millisecond, so replacing never deletes the new file.
  lastIconVersion = Math.max(Date.now(), lastIconVersion + 1);
  const name = `${projectHash(targetPath)}-${lastIconVersion}.${sniffImage(bytes)}`;
  const file = path.join(iconCache(), name);
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
  return { source, file: `data/project-icons/${name}` };
}

function removeManagedIcon(targetPath, icon) {
  // Stored data: only delete this project's own cache files.
  const name = typeof icon?.file === "string" ? path.basename(icon.file) : "";
  if (icon?.file !== `data/project-icons/${name}`) return;
  if (!new RegExp(`^${projectHash(targetPath)}-\\d+\\.(png|jpeg|webp)$`).test(name)) return;
  try { fs.unlinkSync(path.join(iconCache(), name)); } catch {}
}

async function iconFromSource(targetPath, source, value, fetchImpl) {
  if (source === "letter") return { source };
  let bytes;
  if (source === "repo") {
    bytes = repoIcon(targetPath);
    if (!bytes) throw new Error("No usable repo icon");
  } else if (source === "github") {
    const owner = projectOwner(targetPath);
    if (!owner) throw new Error("No usable GitHub owner");
    bytes = await downloadIcon(`https://github.com/${owner}.png?size=64`, fetchImpl, true);
  } else if (source === "custom") {
    if (typeof value !== "string" || !value) throw new Error("Custom icon path or URL is required");
    if (/^https?:\/\//.test(value)) bytes = await downloadIcon(value, fetchImpl);
    else bytes = localIcon(value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
  } else throw new Error("Unknown icon source");
  return writeIcon(targetPath, source, bytes);
}

async function setIcon(targetPath, source, value, { fetchImpl = fetch } = {}) {
  const state = readProjectsFile();
  if (state.error) return { error: state.error };
  const entry = state.projects.find(p => p.path === targetPath);
  if (!entry) return { error: "Project is not saved" };
  let icon;
  try {
    icon = await iconFromSource(targetPath, source, value, fetchImpl);
  } catch (error) {
    return { error: error.message || String(error) };
  }
  // Re-read after the download so a rename made meanwhile is kept.
  const latest = readProjectsFile();
  const current = latest.projects?.find(p => p.path === targetPath);
  if (!current) {
    removeManagedIcon(targetPath, icon);
    return { error: latest.error || "Project is not saved" };
  }
  const previous = current.icon;
  current.icon = icon;
  writeProjectsAtomic(latest.projects);
  removeManagedIcon(targetPath, previous);
  return { path: targetPath, icon };
}

async function resolveIcons({ fetchImpl = fetch } = {}) {
  const state = readProjectsFile();
  if (state.error) return { error: state.error };
  if (state.missing) return listProjects();
  const owners = state.projects.map(p => projectOwner(p.path));
  const counts = new Map();
  for (const owner of owners) if (owner) counts.set(owner.toLowerCase(), (counts.get(owner.toLowerCase()) || 0) + 1);
  const changes = await Promise.all(state.projects.map(async (entry, i) => {
    if (entry.icon) return null;
    try {
      const bytes = repoIcon(entry.path);
      const icon = bytes ? writeIcon(entry.path, "repo", bytes)
        : owners[i] && counts.get(owners[i].toLowerCase()) === 1
          ? await iconFromSource(entry.path, "github", undefined, fetchImpl)
          : { source: "letter" };
      return { path: entry.path, icon };
    } catch { return null; /* Leave unresolved downloads retryable. */ }
  }));
  if (changes.some(Boolean)) {
    // Re-read after the downloads so edits made meanwhile are kept.
    const latest = readProjectsFile();
    if (latest.error) return { error: latest.error };
    let changed = false;
    for (const change of changes) {
      if (!change) continue;
      const current = latest.projects.find(p => p.path === change.path);
      if (!current || current.icon) {
        removeManagedIcon(change.path, change.icon);
        continue;
      }
      current.icon = change.icon;
      changed = true;
    }
    if (changed) writeProjectsAtomic(latest.projects);
  }
  return listProjects();
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

function setGroup(targetPath, name = "") {
  let state = readProjectsFile();
  if (state.error) return { error: state.error };
  let resolvedPath = targetPath;
  let entry = state.projects.find((p) => p.path === resolvedPath);
  if (!entry) {
    const added = addProject(targetPath);
    if (added.error) return { error: added.error };
    resolvedPath = added.path;
    state = readProjectsFile();
    if (state.error) return { error: state.error };
    entry = state.projects.find((p) => p.path === resolvedPath);
    if (!entry) return { error: "Project is not saved" };
  }

  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    delete entry.group;
    writeProjectsAtomic(state.projects);
    return { ok: true, path: entry.path, group: null };
  }

  const lower = trimmed.toLowerCase();
  const existing = state.projects.find(
    (p) => p !== entry && typeof p.group === "string" && p.group.trim().toLowerCase() === lower
  );
  if (existing) {
    entry.group = existing.group.trim();
  } else {
    entry.group = trimmed;
    const idx = state.projects.indexOf(entry);
    if (idx !== -1 && idx !== state.projects.length - 1) {
      state.projects.splice(idx, 1);
      state.projects.push(entry);
    }
  }
  writeProjectsAtomic(state.projects);
  return { ok: true, path: entry.path, group: entry.group };
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
  resolveIcons,
  setIcon,
  githubLogins,
  stateDir,
  listProjects,
  addProject,
  removeProject,
  seedProjects,
  defaultCloneName,
  cloneProject,
  setGroup,
};
