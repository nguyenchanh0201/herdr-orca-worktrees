const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  herdrHome, ownerFromRemote, sniffImage, REPO_ICON_CANDIDATES,
  listProjects, renameProject, githubLogins, resolveIcons, setIcon,
} = require("../src/projects");

const { makeRepo } = require("./helpers/repo");
const CLI = path.resolve(__dirname, "../bin/orca-wt.js");
// A complete 1×1 PNG, not merely a filename or an empty file.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
let tmp;
let previousEnv;
let project;

function save(projects) {
  fs.writeFileSync(path.join(process.env.ORCA_WT_STATE_DIR, "projects.json"), JSON.stringify({ version: 1, projects }));
}
function stored() {
  return JSON.parse(fs.readFileSync(path.join(process.env.ORCA_WT_STATE_DIR, "projects.json"), "utf8")).projects;
}
function cli(...args) {
  return spawnSync(process.execPath, [CLI, "projects", ...args], { encoding: "utf8", env: process.env });
}

test.beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-icons-")));
  previousEnv = {};
  for (const key of ["ORCA_WT_STATE_DIR", "HERDR_APP_HOME", "GH_CONFIG_DIR"]) {
    previousEnv[key] = process.env[key];
    process.env[key] = path.join(tmp, key);
    fs.mkdirSync(process.env[key]);
  }
  project = path.join(tmp, "project");
  fs.mkdirSync(project);
});
test.afterEach(() => {
  // tmp is the absolute mkdtemp directory created by this test only.
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function repo(t, owner, files = {}) {
  const r = makeRepo({ files });
  t.after(() => r.cleanup());
  if (owner) {
    const result = spawnSync("git", ["-C", r.primary, "remote", "add", "origin", `git@github.com:${owner}/x.git`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return r.primary;
}
function iconFile(icon) { return path.join(process.env.HERDR_APP_HOME, icon.file || icon); }
function noFetch() { assert.fail("unexpected network request"); }

// Removing source selection, size validation, or persist-before-cleanup must break these behaviors.
test("resolveIcons prefers a repo icon", async (t) => {
  const p = repo(t, "solo", { "public/logo.png": PNG });
  save([{ path: p, name: "Keep", future: { keep: true } }]);
  const result = await resolveIcons({ fetchImpl: noFetch });
  assert.equal(result.projects[0].iconSource, "repo");
  assert.deepEqual(fs.readFileSync(iconFile(result.projects[0].icon)), PNG);
  assert.match(result.projects[0].icon, /^data\/project-icons\/[a-f0-9]{40}-\d+\.png$/);
  assert.deepEqual(stored()[0].future, { keep: true });
  assert.equal(stored()[0].name, "Keep");
});

test("resolveIcons uses the avatar for a unique owner", async (t) => {
  save([{ path: repo(t, "solo") }]);
  let calls = 0;
  const result = await resolveIcons({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "https://github.com/solo.png?size=64");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(PNG);
  } });
  assert.equal(calls, 1);
  assert.equal(result.projects[0].iconSource, "github");
  assert.deepEqual(fs.readFileSync(iconFile(result.projects[0].icon)), PNG);
});

test("resolveIcons skips a shared owner including resolved entries", async (t) => {
  const a = repo(t, "CODUCT"), b = repo(t, "coduct");
  save([{ path: a }, { path: b }]);
  assert.deepEqual((await resolveIcons({ fetchImpl: noFetch })).projects.map(p => p.iconSource), ["letter", "letter"]);
  save([{ path: a }, { path: b, icon: { source: "custom", file: "missing.png" } }]);
  assert.deepEqual((await resolveIcons({ fetchImpl: noFetch })).projects.map(p => p.iconSource), ["letter", "custom"]);
});

test("resolveIcons leaves icon unset when the fetch fails and retries", async (t) => {
  save([{ path: repo(t, "solo") }]);
  assert.equal((await resolveIcons({ fetchImpl: async () => { throw Error("offline"); } })).projects[0].iconSource, null);
  assert.equal(Object.hasOwn(stored()[0], "icon"), false);
  assert.equal((await resolveIcons({ fetchImpl: async () => new Response(PNG) })).projects[0].iconSource, "github");
});

test("resolveIcons stores letter with no remote and no file", async (t) => {
  save([{ path: repo(t) }]);
  assert.equal((await resolveIcons({ fetchImpl: noFetch })).projects[0].iconSource, "letter");
  assert.deepEqual(stored()[0].icon, { source: "letter" });
});

test("resolveIcons does not touch resolved entries", async (t) => {
  const entries = ["letter", "repo", "github", "custom"].map(source => ({ path: repo(t, source), icon: { source }, extra: true }));
  save(entries);
  await resolveIcons({ fetchImpl: noFetch });
  assert.deepEqual(stored(), entries);
});

test("resolveIcons rejects a non-image avatar", async (t) => {
  save([{ path: repo(t, "solo") }]);
  assert.equal((await resolveIcons({ fetchImpl: async () => new Response("<html>") })).projects[0].iconSource, null);
  assert.equal(Object.hasOwn(stored()[0], "icon"), false);
});

test("resolveIcons skips invalid and oversized repo candidates in order", async (t) => {
  const webp = Buffer.from("RIFF\0\0\0\0WEBP");
  const p = repo(t, null, { "favicon.png": "bad", "favicon.webp": Buffer.alloc(262145), "public/favicon.png": PNG, "public/favicon.webp": webp });
  save([{ path: p }]);
  const result = await resolveIcons({ fetchImpl: noFetch });
  assert.equal(result.projects[0].iconSource, "repo");
  assert.deepEqual(fs.readFileSync(iconFile(result.projects[0].icon)), PNG);
});

test("resolveIcons starts independent avatar fetches in parallel", async (t) => {
  save([{ path: repo(t, "one") }, { path: repo(t, "two") }]);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const result = await resolveIcons({ fetchImpl: async () => {
    if (++calls === 2) release();
    await barrier;
    return new Response(PNG);
  } });
  assert.deepEqual(result.projects.map(p => p.iconSource), ["github", "github"]);
});

test("setIcon custom from file replaces the old file even in the same millisecond", async () => {
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  save([{ path: project, name: "Keep", future: 42 }]);
  const now = Date.now;
  Date.now = () => 1700000000000;
  try {
    const first = await setIcon(project, "custom", source);
    const second = await setIcon(project, "custom", source);
    assert.equal(first.icon.source, "custom");
    assert.notEqual(first.icon.file, second.icon.file);
    assert.equal(fs.existsSync(iconFile(first.icon)), false);
    assert.deepEqual(fs.readFileSync(iconFile(second.icon)), PNG);
    assert.deepEqual(fs.readFileSync(source), PNG);
    assert.deepEqual(stored(), [{ path: project, name: "Keep", future: 42, icon: second.icon }]);
  } finally { Date.now = now; }
});

test("setIcon letter removes only the replaced managed cache", async () => {
  fs.writeFileSync(path.join(tmp, "source.png"), PNG);
  save([{ path: project }]);
  const first = await setIcon(project, "custom", path.join(tmp, "source.png"));
  assert.deepEqual(await setIcon(project, "letter"), { path: project, icon: { source: "letter" } });
  assert.equal(fs.existsSync(iconFile(first.icon)), false);
});

test("setIcon on an unsaved path errors without fetching", async () => {
  save([]);
  assert.ok((await setIcon(project, "custom", "https://example.test/icon", { fetchImpl: noFetch })).error);
  assert.deepEqual(stored(), []);
});

test("setIcon source failures keep old icon metadata and bytes", async (t) => {
  const p = repo(t, null);
  const source = path.join(tmp, "source.png"), large = path.join(tmp, "large.png");
  fs.writeFileSync(source, PNG);
  fs.writeFileSync(large, Buffer.alloc(300 * 1024));
  save([{ path: p }]);
  const first = await setIcon(p, "custom", source);
  const before = stored();
  for (const [kind, value, fetchImpl] of [
    ["unknown"], ["custom"], ["custom", large], ["custom", path.join(tmp, "missing")],
    ["repo"], ["github"], ["custom", "https://example.test/x", async () => { throw Error("offline"); }],
    ["custom", "http://example.test/x", async () => new Response(PNG, { status: 500 })],
    ["custom", "https://example.test/x", async () => new Response("<html>")],
  ]) {
    assert.ok((await setIcon(p, kind, value, { fetchImpl })).error, kind);
    assert.deepEqual(stored(), before);
    assert.deepEqual(fs.readFileSync(iconFile(first.icon)), PNG);
  }
});

test("setIcon explicit github ignores shared owners, rejects WebP and accepts JPEG", async (t) => {
  const a = repo(t, "same"), b = repo(t, "SAME");
  save([{ path: a }, { path: b }]);
  assert.ok((await setIcon(a, "github", undefined, { fetchImpl: async () => new Response(Buffer.from("RIFF\0\0\0\0WEBP")) })).error);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const result = await setIcon(a, "github", undefined, { fetchImpl: async () => new Response(jpeg) });
  assert.equal(result.icon.source, "github");
  assert.match(result.icon.file, /\.jpeg$/);
  assert.deepEqual(fs.readFileSync(iconFile(result.icon)), jpeg);
});

test("setIcon repo and custom URL accept WebP and boundary-sized files", async (t) => {
  const webp = Buffer.from("RIFF\0\0\0\0WEBP");
  const p = repo(t, null, { "favicon.webp": webp });
  save([{ path: p }]);
  assert.equal((await setIcon(p, "repo")).icon.source, "repo");
  const bytes = Buffer.concat([PNG, Buffer.alloc(262144 - PNG.length)]);
  const result = await setIcon(p, "custom", "https://example.test/x", { fetchImpl: async () => new Response(bytes) });
  assert.equal(result.icon.source, "custom");
  assert.deepEqual(fs.readFileSync(iconFile(result.icon)), bytes);
  assert.equal((await setIcon(p, "custom", "http://example.test/x", { fetchImpl: async () => new Response(webp) })).icon.source, "custom");
});

test("setIcon expands home-relative custom file paths", async () => {
  save([{ path: project }]);
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  const value = `~/${path.relative(os.homedir(), source)}`;
  const result = await setIcon(project, "custom", value);
  assert.deepEqual(fs.readFileSync(iconFile(result.icon)), PNG);
});

test("setIcon stops oversized streamed downloads and preserves old icon", async () => {
  save([{ path: project, icon: { source: "letter" } }]);
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(65536)); },
    cancel() { cancelled = true; },
  });
  assert.ok((await setIcon(project, "custom", "https://example.test/x", { fetchImpl: async () => new Response(stream) })).error);
  assert.equal(cancelled, true);
  assert.deepEqual(stored()[0].icon, { source: "letter" });
});

test("setIcon timeout covers a stalled response body", async (t) => {
  save([{ path: project, icon: { source: "letter" } }]);
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 10000);
    return timeout(20);
  });
  let cancelled = false;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await setIcon(project, "custom", "https://example.test/x", { fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    assert.ok(result.error);
    assert.equal(cancelled, true);
    assert.deepEqual(stored()[0].icon, { source: "letter" });
  } finally { clearTimeout(keepAlive); }
});

test("setIcon never deletes arbitrary stored files or symlink targets", async () => {
  const outside = path.join(tmp, "outside.png");
  fs.writeFileSync(outside, PNG);
  const home = process.env.HERDR_APP_HOME;
  fs.mkdirSync(path.join(home, "data/project-icons"), { recursive: true });
  const linked = path.join(home, "data/project-icons", `${require("node:crypto").createHash("sha1").update(project).digest("hex")}-1.png`);
  fs.symlinkSync(outside, linked);
  fs.writeFileSync(path.join(home, "source.png"), PNG);
  for (const file of [outside, "../outside.png", "source.png", path.relative(home, linked)]) {
    save([{ path: project, icon: { source: "custom", file } }]);
    assert.equal((await setIcon(project, "letter")).icon.source, "letter");
    assert.deepEqual(fs.readFileSync(outside), PNG);
    assert.deepEqual(fs.readFileSync(path.join(home, "source.png")), PNG);
  }
});

test("cli projects resolve-icons and set-icon await results", () => {
  save([{ path: project }]);
  const resolved = cli("resolve-icons");
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).projects[0].iconSource, "letter");
  const source = path.join(tmp, "source with spaces.png");
  fs.writeFileSync(source, PNG);
  const result = cli("set-icon", project, "custom", source);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.path, project);
  assert.equal(data.icon.source, "custom");
  assert.deepEqual(fs.readFileSync(iconFile(data.icon)), PNG);
});

test("setIcon persistence failure retains the prior icon and cleans the new cache", async (t) => {
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  save([{ path: project }]);
  const first = await setIcon(project, "custom", source);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === path.join(process.env.ORCA_WT_STATE_DIR, "projects.json")) throw Error("persist failed");
    return rename(from, to);
  });
  assert.ok((await setIcon(project, "custom", source)).error);
  assert.deepEqual(stored()[0].icon, first.icon);
  assert.deepEqual(fs.readFileSync(iconFile(first.icon)), PNG);
  assert.deepEqual(fs.readdirSync(path.dirname(iconFile(first.icon))), [path.basename(first.icon.file)]);
});

test("setIcon cleanup failure still reports the persisted replacement", async (t) => {
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  save([{ path: project }]);
  const first = await setIcon(project, "custom", source);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", file => {
    if (file === iconFile(first.icon)) {
      assert.deepEqual(stored()[0].icon, { source: "letter" });
      throw Error("cleanup denied");
    }
    return unlink(file);
  });
  assert.deepEqual(await setIcon(project, "letter"), { path: project, icon: { source: "letter" } });
  assert.deepEqual(stored()[0].icon, { source: "letter" });
});

test("setIcon does not remove a pre-existing temporary cache file", async (t) => {
  const timestamp = 9000000000000;
  t.mock.method(Date, "now", () => timestamp);
  const cache = path.join(process.env.HERDR_APP_HOME, "data/project-icons");
  fs.mkdirSync(cache, { recursive: true });
  const hash = require("node:crypto").createHash("sha1").update(project).digest("hex");
  const existing = path.join(cache, `${hash}-${timestamp}.png.tmp`);
  fs.writeFileSync(existing, "not ours");
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  save([{ path: project, icon: { source: "letter" } }]);
  assert.ok((await setIcon(project, "custom", source)).error);
  assert.equal(fs.readFileSync(existing, "utf8"), "not ours");
  assert.deepEqual(stored()[0].icon, { source: "letter" });
});

test("setIcon rejects symlinked cache ancestors before creating outside directories", async () => {
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(process.env.HERDR_APP_HOME, "data"));
  const source = path.join(tmp, "source.png");
  fs.writeFileSync(source, PNG);
  save([{ path: project, icon: { source: "letter" } }]);
  assert.ok((await setIcon(project, "custom", source)).error);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(stored()[0].icon, { source: "letter" });
});

test("herdrHome honours override and defaults to user config", () => {
  assert.equal(herdrHome(), process.env.HERDR_APP_HOME);
  delete process.env.HERDR_APP_HOME;
  assert.equal(herdrHome(), path.join(os.homedir(), ".config", "herdr-app"));
});

test("ownerFromRemote", () => {
  for (const [url, owner] of [
    ["git@github.com:CODUCT/Coduct.CTM.Server.git", "CODUCT"],
    ["https://github.com/punarinta/make-slack-great-again.git", "punarinta"],
    ["https://github.com/qnguyen3/zalo-swift-re", "qnguyen3"],
    ["git@github-nguyenchanh0201:nguyenchanh0201/vietqr-node.git", "nguyenchanh0201"],
    ["ssh://git@github.com/O/R.git", "O"],
    ["git@gitlab.com:o/r.git", null], ["", null],
    ["https://github.com/owner", null], ["not a url", null],
    ["https://github.com//repo", null], [null, null],
  ]) assert.equal(ownerFromRemote(url), owner, String(url));
});

test("sniffImage", () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBP")), "webp");
  assert.equal(sniffImage(Buffer.from("<svg")), null);
  assert.equal(sniffImage(Buffer.from("RIFF")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("sniffImage rejects high-bit-mutated WebP magic", () => {
  for (const hex of [
    "d2c9c6c60000000057454250",
    "5249464600000000d7c5c2d0",
    "d2c9c6c600000000d7c5c2d0",
  ]) assert.equal(sniffImage(Buffer.from(hex, "hex")), null, hex);
});

test("listProjects falls back for high-bit-mutated WebP magic without rewriting data", () => {
  fs.writeFileSync(path.join(process.env.HERDR_APP_HOME, "corrupt.webp"), Buffer.from("d2c9c6c600000000d7c5c2d0", "hex"));
  const entries = [{ path: project, icon: { source: "custom", file: "corrupt.webp" } }];
  save(entries);
  assert.deepEqual(listProjects().projects, [{ path: project, exists: true, name: null, icon: null, iconSource: "custom" }]);
  assert.deepEqual(stored(), entries);
});

test("REPO_ICON_CANDIDATES order", () => {
  assert.deepEqual(REPO_ICON_CANDIDATES, [
    "favicon.png", "favicon.webp", "public/favicon.png", "public/favicon.webp",
    "app/favicon.png", "app/favicon.webp", "app/icon.png", "app/icon.webp",
    "src/favicon.png", "src/favicon.webp", "src/app/icon.png", "src/app/icon.webp",
    "assets/favicon.png", "assets/favicon.webp", "assets/icon.png", "assets/icon.webp",
    "static/favicon.png", "static/favicon.webp", "logo.png", "logo.webp",
    "public/logo.png", "public/logo.webp", "public/icon.png", "public/icon.webp",
    "src-tauri/icons/icon.png", "src-tauri/icons/icon.webp", "app-icon.png", "app-icon.webp",
    "icon.png", "icon.webp",
  ]);
});

test("listProjects reads old entries and reports name/icon", () => {
  const icons = path.join(process.env.HERDR_APP_HOME, "data/project-icons");
  fs.mkdirSync(icons, { recursive: true });
  fs.writeFileSync(path.join(icons, "x.png"), PNG);
  const b = path.join(tmp, "B"), c = path.join(tmp, "C"), d = path.join(tmp, "D");
  save([{ path: project }, { path: b, name: "Admin", icon: { source: "github", file: "data/project-icons/x.png" } },
    { path: c, icon: { source: "letter", file: "data/project-icons/x.png" } },
    { path: d, icon: { source: "repo", file: "data/project-icons/gone.png" } }]);
  assert.deepEqual(listProjects(), { seeded: true, projects: [
    { path: project, exists: true, name: null, icon: null, iconSource: null },
    { path: b, exists: false, name: "Admin", icon: "data/project-icons/x.png", iconSource: "github" },
    { path: c, exists: false, name: null, icon: null, iconSource: "letter" },
    { path: d, exists: false, name: null, icon: null, iconSource: "repo" },
  ] });
});

test("listProjects falls back for corrupt, oversized, and non-file icons without rewriting data", () => {
  const home = process.env.HERDR_APP_HOME;
  fs.writeFileSync(path.join(home, "corrupt.png"), "not an image");
  fs.writeFileSync(path.join(home, "large.png"), Buffer.concat([PNG, Buffer.alloc(262145 - PNG.length)]));
  fs.writeFileSync(path.join(home, "limit.png"), Buffer.concat([PNG, Buffer.alloc(262144 - PNG.length)]));
  const entries = ["corrupt.png", "large.png", "ORCA-missing.png", ".", "limit.png"].map(file => ({ path: project, icon: { source: "custom", file } }));
  save(entries);
  assert.deepEqual(listProjects().projects.map(p => p.icon), [null, null, null, null, "limit.png"]);
  assert.deepEqual(stored(), entries);
});

test("listProjects rejects icon paths outside Herdr home", () => {
  const outside = path.join(tmp, "outside.png");
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(process.env.HERDR_APP_HOME, "linked.png"));
  save(["../outside.png", outside, "linked.png"].map(file => ({ path: project, icon: { source: "custom", file } })));
  assert.deepEqual(listProjects().projects.map(p => p.icon), [null, null, null]);
});

test("renameProject sets, trims, clears; unsaved path errors; retains every other stored field", () => {
  const original = { path: project, icon: { source: "letter" }, future: { keep: true } };
  const other = { path: "/another", name: "Other", extra: 123 };
  save([original, other]);
  assert.deepEqual(renameProject(project, "  Admin Portal "), { path: project, name: "Admin Portal" });
  assert.deepEqual(stored(), [{ ...original, name: "Admin Portal" }, other]);
  assert.deepEqual(renameProject(project, ""), { path: project, name: null });
  assert.deepEqual(stored(), [original, other]);
  renameProject(project, "Again");
  assert.deepEqual(renameProject(project), { path: project, name: null });
  assert.deepEqual(stored(), [original, other]);
  assert.ok(renameProject("/not/saved", "x").error);
  assert.deepEqual(stored(), [original, other]);
});

test("renameProject does not overwrite missing or corrupt project state", () => {
  assert.ok(renameProject(project, "Name").error);
  assert.equal(fs.existsSync(path.join(process.env.ORCA_WT_STATE_DIR, "projects.json")), false);
  const file = path.join(process.env.ORCA_WT_STATE_DIR, "projects.json");
  fs.writeFileSync(file, "{broken");
  assert.ok(renameProject(project, "Name").error);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("githubLogins reads hosts.yml users and deduplicates across hosts", () => {
  fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\n    users:\n        jimmy-nguyen-codeleap:\n        nguyenchanh0201:\n    user: jimmy-nguyen-codeleap\nother.host:\n    users:\n        nguyenchanh0201:\n    user: enterprise-user\n");
  assert.deepEqual(githubLogins(), ["jimmy-nguyen-codeleap", "nguyenchanh0201", "enterprise-user"]);
});

test("githubLogins returns empty on missing or invalid YAML", () => {
  assert.deepEqual(githubLogins(), []);
  fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"), "broken: [");
  assert.deepEqual(githubLogins(), []);
});

test("cli projects logins prints JSON with a logins array", () => {
  fs.writeFileSync(path.join(process.env.GH_CONFIG_DIR, "hosts.yml"), "github.com:\n  user: jimmy-nguyen-codeleap\n");
  const result = cli("logins");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { logins: ["jimmy-nguyen-codeleap"] });
});

test("cli projects rename joins name arguments and clears an omitted name", () => {
  save([{ path: project, icon: { source: "letter" } }]);
  const result = cli("rename", project, "--Admin", "Portal");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { path: project, name: "--Admin Portal" });
  const cleared = cli("rename", project);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(stored(), [{ path: project, icon: { source: "letter" } }]);
});
