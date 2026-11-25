const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const release = require("./gitview-release.json");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function ensureEngine(appHome) {
  if (process.env.GITVIEW_BIN) {
    const binary = path.resolve(process.env.GITVIEW_BIN);
    fs.accessSync(binary, fs.constants.X_OK);
    return binary;
  }
  const arch = {arm64: "aarch64", x64: "x86_64"}[os.arch()];
  const platform = {darwin: "apple-darwin", linux: "unknown-linux-gnu"}[os.platform()];
  const target = `${arch}-${platform}`;
  const expected = release.sha256[target];
  if (!expected) throw new Error(`No prebuilt gitview engine for ${os.platform()}/${os.arch()}; set GITVIEW_BIN`);
  const dir = path.join(appHome, "gitview", release.version, target);
  const binary = path.join(dir, "herdr-gitview");
  const receipt = path.join(dir, "sha256");
  if (fs.existsSync(binary) && fs.existsSync(receipt) && sha256(binary) === fs.readFileSync(receipt, "utf8").trim()) return binary;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "orca-gitview-"));
  try {
    const archive = path.join(work, "app.tar.gz");
    const name = `herdr-gitview-app-${target}.tar.gz`;
    console.error(`Downloading gitview engine ${release.version} (${target})`);
    execFileSync("curl", ["-fsSL", "--retry", "3", "--max-time", "120", `https://github.com/ChmaraX/herdr-gitview/releases/download/${release.version}/${name}`, "-o", archive], {stdio: "inherit"});
    if (sha256(archive) !== expected) throw new Error("gitview bundle SHA-256 mismatch; engine not installed");
    const member = `herdr-gitview-app-${target}/bin/herdr-gitview`;
    execFileSync("tar", ["-xzf", archive, "-C", work, member], {stdio: "inherit"});
    fs.mkdirSync(dir, {recursive: true});
    fs.copyFileSync(path.join(work, member), `${binary}.tmp`);
    fs.chmodSync(`${binary}.tmp`, 0o755);
    fs.renameSync(`${binary}.tmp`, binary);
    fs.writeFileSync(receipt, sha256(binary) + "\n");
    return binary;
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

if (require.main === module) {
  try { console.log(ensureEngine(path.resolve(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exit(1); }
}

module.exports = { ensureEngine };
