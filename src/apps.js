const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stateDir, herdrHome } = require("./projects");

const APPS = [
  { id: "vscode", name: "VS Code", app: "Visual Studio Code" },
  { id: "zed", name: "Zed", app: "Zed" },
  { id: "cursor", name: "Cursor", app: "Cursor" },
  { id: "xcode", name: "Xcode", app: "Xcode" },
  { id: "terminal", name: "Terminal", app: "Terminal" },
  { id: "ghostty", name: "Ghostty", app: "Ghostty" },
  { id: "finder", name: "Finder", app: null },
];

const DEFAULT_EXCLUDED = new Set(["terminal", "ghostty"]);

const DEFAULT_DIRS = [
  "/Applications",
  path.join(os.homedir(), "Applications"),
  "/System/Applications",
  "/System/Applications/Utilities",
];

function appsFilePath() {
  return path.join(stateDir(), "apps.json");
}

function resolveAppIcon(entry, bundlePath) {
  const rel = `data/app-icons/${entry.id}.png`;
  const dest = path.join(herdrHome(), rel);
  if (fs.existsSync(dest)) return rel;
  if (!bundlePath || !fs.existsSync(path.join(bundlePath, "Contents", "Info.plist"))) return null;

  const plist = spawnSync(
    "plutil",
    ["-extract", "CFBundleIconFile", "raw", path.join(bundlePath, "Contents", "Info.plist")],
    { encoding: "utf8" }
  );
  if (plist.status !== 0) return null;
  let iconName = (plist.stdout || "").trim();
  if (!iconName) return null;
  if (!iconName.endsWith(".icns")) iconName += ".icns";
  const icnsPath = path.join(bundlePath, "Contents", "Resources", iconName);
  if (!fs.existsSync(icnsPath)) return null;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const conv = spawnSync("sips", ["-s", "format", "png", "-z", "32", "32", icnsPath, "--out", dest], {
      encoding: "utf8",
    });
    if (conv.status === 0 && fs.existsSync(dest)) return rel;
  } catch {
    return null;
  }
  return null;
}

function installedApps(dirs = DEFAULT_DIRS) {
  const searchDirs = Array.isArray(dirs) ? dirs : DEFAULT_DIRS;
  const out = [];
  for (const a of APPS) {
    let bundle = null;
    if (a.id === "finder") {
      bundle = "/System/Library/CoreServices/Finder.app";
    } else {
      for (const d of searchDirs) {
        const candidate = path.join(d, `${a.app}.app`);
        if (fs.existsSync(candidate)) {
          bundle = candidate;
          break;
        }
      }
      if (!bundle) continue;
    }
    out.push({ id: a.id, name: a.name, icon: resolveAppIcon(a, bundle) });
  }
  return out;
}

function readSavedApps() {
  try {
    const raw = fs.readFileSync(appsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.apps)) {
      return parsed.apps.filter((id) => typeof id === "string");
    }
  } catch {
    // Missing or unreadable file falls back to defaults.
  }
  return null;
}

function listApps({ dirs } = {}) {
  const installed = installedApps(dirs);
  const installedIds = new Set(installed.map((a) => a.id));
  const saved = readSavedApps();
  if (!saved) {
    return {
      installed,
      chosen: installed.filter((a) => !DEFAULT_EXCLUDED.has(a.id)).map((a) => a.id),
    };
  }
  const savedSet = new Set(saved);
  return {
    installed,
    chosen: installed.filter((a) => savedSet.has(a.id) && installedIds.has(a.id)).map((a) => a.id),
  };
}

function setApps(ids = []) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const apps = APPS.filter((a) => wanted.has(a.id)).map((a) => a.id);
  const file = appsFilePath();
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.apps-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, apps }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, apps };
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { error: err && err.message ? err.message : String(err) };
  }
}

function openArgv(id, folder) {
  const entry = APPS.find((a) => a.id === id);
  if (!entry) return null;
  if (entry.id === "finder") return [folder];
  return ["-a", entry.app, folder];
}

function openIn(id, folder) {
  if (!folder || !fs.existsSync(folder)) {
    return { error: `Folder does not exist: ${folder || ""}` };
  }
  const argv = openArgv(id, folder);
  if (!argv) {
    return { error: `Unknown app: ${id}` };
  }
  const res = spawnSync("open", argv, { encoding: "utf8" });
  if (res.error) {
    return { error: res.error.message };
  }
  if (res.status !== 0) {
    return { error: (res.stderr || "").trim() || `open exited with status ${res.status}` };
  }
  return { ok: true };
}

module.exports = {
  APPS,
  DEFAULT_DIRS,
  installedApps,
  listApps,
  setApps,
  openArgv,
  openIn,
};
