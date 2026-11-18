const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

// The shared ui/ files: tokens.js first, then layer by layer (atoms, molecules, organisms), each
// layer in name order.
function uiFiles() {
  const dir = path.join(ROOT, "ui");
  const layers = ["atoms", "molecules", "organisms"];
  return [
    path.join(dir, "tokens.js"),
    ...layers.flatMap((layer) =>
      fs
        .readdirSync(path.join(dir, layer))
        .filter((f) => f.endsWith(".js"))
        .sort()
        .map((f) => path.join(dir, layer, f)),
    ),
  ];
}

// Herdr loads a mod as ES modules, but these tests run the source in a vm with the native GPUI/Herdr
// names injected as globals. So a mod's source is the shared ui/ library (when the mod links it), its
// `*.view.js` files (render helpers split out of main.js), then main.js, with imports dropped and
// `export` keywords removed. Import-free helpers (group.js, tree.js, ...) are not `*.view.js`; tests
// import those and inject them.
function readModSource(mod) {
  const dir = path.join(ROOT, "mods", mod);
  const usesUi = fs.existsSync(path.join(dir, "ui"));
  const files = [
    ...(usesUi ? uiFiles() : []),
    ...fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".view.js"))
      .sort()
      .map((f) => path.join(dir, f)),
    path.join(dir, "main.js"),
  ];
  return files
    .map((f) =>
      fs
        .readFileSync(f, "utf8")
        .replace(/^import\b[\s\S]*?;\n/gm, "")
        .replace(/^export default class /gm, "class ")
        .replace(/^export /gm, ""),
    )
    .join("\n");
}

module.exports = { readModSource };
