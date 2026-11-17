const { fetchClaude } = require("./claude");
const { fetchCodex } = require("./codex");
const { fetchAgy } = require("./agy");

const PROVIDER_ORDER = ["claude", "codex", "agy"];

async function fetchAll({ only, skip = [], deps } = {}) {
  const resolvedDeps = deps || {
    claude: fetchClaude,
    codex: fetchCodex,
    agy: fetchAgy,
  };

  const selected = only
    ? PROVIDER_ORDER.filter((id) => id === only)
    : PROVIDER_ORDER.filter((id) => !skip.includes(id));

  const providers = await Promise.all(
    selected.map(async (id) => {
      try {
        return await resolvedDeps[id]();
      } catch {
        return {
          id,
          status: "error",
          error: "Couldn't read usage",
          windows: [],
          fetchedAt: Date.now(),
        };
      }
    })
  );

  return { providers };
}

module.exports = { fetchAll };
