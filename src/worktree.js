const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SEA_CREATURES = [
  "octopus",
  "narwhal",
  "dolphin",
  "orca",
  "beluga",
  "manatee",
  "walrus",
  "penguin",
  "puffin",
  "pelican",
  "albatross",
  "seahorse",
  "starfish",
  "jellyfish",
  "stingray",
  "manta",
  "hammerhead",
  "swordfish",
  "marlin",
  "barracuda",
  "grouper",
  "snapper",
  "flounder",
  "halibut",
  "salmon",
  "trout",
  "sturgeon",
  "coelacanth",
  "nautilus",
  "cuttlefish",
  "squid",
  "lobster",
  "crab",
  "shrimp",
  "krill",
  "barnacle",
  "clam",
  "oyster",
  "scallop",
  "mussel",
  "abalone",
  "urchin",
  "anemone",
  "coral",
  "sponge",
  "otter",
  "seal",
  "sealion",
  "turtle",
  "dugong",
];

function slug(branch) {
  const normalized = branch.normalize("NFC");
  const name = normalized.replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  if (name) return name;
  let hash = 2166136261;
  for (const char of normalized) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return `branch-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function suggestName(used, random = Math.random) {
  const usedSet = used instanceof Set ? used : new Set(used || []);
  const unused = SEA_CREATURES.filter((name) => !usedSet.has(name));
  if (unused.length > 0) {
    return unused[Math.floor(random() * unused.length) % unused.length];
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidates = SEA_CREATURES.map((name) => `${name}-${suffix}`).filter(
      (name) => !usedSet.has(name),
    );
    if (candidates.length > 0) {
      return candidates[Math.floor(random() * candidates.length) % candidates.length];
    }
  }
}

function gitRun(repo, args, opts = {}) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    ...opts,
  });
}

function parseLines(stdout) {
  const seen = new Set();
  const out = [];
  for (const raw of (stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  }
  return out;
}

function parseCheckedOut(repo) {
  const r = gitRun(repo, ["worktree", "list", "--porcelain"]);
  if (r.status !== 0) return {};
  const checkedOut = {};
  let currentPath = null;
  for (const raw of (r.stdout || "").split(/\r?\n/)) {
    if (raw.startsWith("worktree ")) {
      currentPath = raw.slice("worktree ".length);
      try {
        currentPath = fs.realpathSync(currentPath);
      } catch {
        // Keep raw path if realpath fails (e.g. prunable worktree).
      }
    } else if (raw.startsWith("branch refs/heads/") && currentPath) {
      const branch = raw.slice("branch refs/heads/".length);
      checkedOut[branch] = currentPath;
    } else if (raw === "") {
      currentPath = null;
    }
  }
  return checkedOut;
}

function readRepoRefs(repo) {
  const localRes = gitRun(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (localRes.status !== 0) {
    const msg = (localRes.stderr || localRes.stdout || "git for-each-ref failed").trim();
    return { error: msg };
  }
  const local = parseLines(localRes.stdout);

  const remoteRes = gitRun(repo, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/remotes",
  ]);
  const remote =
    remoteRes.status === 0
      ? parseLines(remoteRes.stdout).filter((r) => r.includes("/") && !r.endsWith("/HEAD"))
      : [];

  const checkedOut = parseCheckedOut(repo);
  return { local, remote, checkedOut };
}

function buildUsedSet(repo, root, local, remote) {
  const used = new Set(local);
  for (const r of remote) {
    used.add(r);
    const slash = r.indexOf("/");
    if (slash !== -1) used.add(r.slice(slash + 1));
  }
  if (root) {
    const repoDir = path.join(root, path.basename(repo));
    try {
      for (const entry of fs.readdirSync(repoDir, { withFileTypes: true })) {
        used.add(entry.name);
      }
    } catch {
      // Directory may not exist yet.
    }
  }
  return used;
}

function resolveDefaultBranch(repo, local) {
  const localSet = new Set(local);
  const sym = gitRun(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.status === 0) {
    const ref = sym.stdout.trim();
    if (ref) {
      const stripped = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
      return localSet.has(stripped) ? stripped : ref;
    }
  }
  if (localSet.has("main")) return "main";
  if (localSet.has("master")) return "master";
  const head = gitRun(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status === 0) {
    const cur = head.stdout.trim();
    if (cur && cur !== "HEAD") return cur;
  }
  return local[0] ?? null;
}

function listBranches(repo, root) {
  if (!repo) return { error: "Missing repository path" };
  const refs = readRepoRefs(repo);
  if (refs.error) return refs;

  const { local, remote, checkedOut } = refs;
  const defaultBranch = resolveDefaultBranch(repo, local);
  const used = buildUsedSet(repo, root, local, remote);
  const suggested = suggestName(used);

  return {
    default: defaultBranch,
    local,
    remote,
    checkedOut,
    suggested,
  };
}

function prepareDest(root, repoName, branchName) {
  const dest = path.join(root, repoName, slug(branchName));
  if (fs.existsSync(dest)) {
    return { error: `${dest} already exists` };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return { dest };
}

function addWorktree(repo, { base, name, root } = {}, { random } = {}) {
  if (!repo) return { error: "Missing repository path" };
  if (!base) return { error: "Missing base ref" };
  if (!root) return { error: "Missing worktrees root directory" };

  const refs = readRepoRefs(repo);
  if (refs.error) return refs;

  const { local, remote, checkedOut } = refs;
  const localSet = new Set(local);
  const repoName = path.basename(repo);
  const isRemoteBase = remote.includes(base) && !localSet.has(base);
  const trimmedName = typeof name === "string" ? name.trim() : "";

  function worktreeAdd(args) {
    const r = gitRun(repo, ["worktree", "add", ...args], { timeout: 590000 });
    if (r.status !== 0 || r.error) {
      const raw = r.stderr || r.stdout || (r.error && r.error.message) || "git worktree add failed";
      const lines = raw.trim().split(/\r?\n/).slice(-20).join("\n");
      return { error: lines };
    }
    return null;
  }

  // Case 1: explicit new branch name provided
  if (trimmedName) {
    const check = gitRun(repo, ["check-ref-format", "--branch", trimmedName]);
    if (check.status !== 0) {
      return { error: `Invalid branch name: ${trimmedName}` };
    }
    if (localSet.has(trimmedName)) {
      return {
        error: `${trimmedName} already exists — pick it as Create From and leave the name empty`,
      };
    }
    const remoteMatch = remote.find((r) => r.slice(r.indexOf("/") + 1) === trimmedName);
    if (remoteMatch) {
      const remoteName = remoteMatch.slice(0, remoteMatch.indexOf("/"));
      return {
        error: `${trimmedName} exists on ${remoteName} — pick ${remoteMatch} as Create From`,
      };
    }
    const prep = prepareDest(root, repoName, trimmedName);
    if (prep.error) return prep;

    const args = isRemoteBase
      ? ["--no-track", "-b", trimmedName, prep.dest, base]
      : ["-b", trimmedName, prep.dest, base];
    const err = worktreeAdd(args);
    if (err) return err;
    return { path: prep.dest, branch: trimmedName };
  }

  // No name provided
  let targetBranch = base;
  if (isRemoteBase) {
    const short = base.slice(base.indexOf("/") + 1);
    if (!localSet.has(short)) {
      // Case 3: remote-only branch -> create tracking local branch
      const prep = prepareDest(root, repoName, short);
      if (prep.error) return prep;
      const err = worktreeAdd(["--track", "-b", short, prep.dest, base]);
      if (err) return err;
      return { path: prep.dest, branch: short };
    }
    targetBranch = short;
  }

  // Case 2: free local branch
  if (!checkedOut[targetBranch]) {
    const prep = prepareDest(root, repoName, targetBranch);
    if (prep.error) return prep;
    const err = worktreeAdd([prep.dest, targetBranch]);
    if (err) return err;
    return { path: prep.dest, branch: targetBranch };
  }

  // Case 4: already checked out -> generated branch name
  const used = buildUsedSet(repo, root, local, remote);
  const genName = suggestName(used, random);
  const prep = prepareDest(root, repoName, genName);
  if (prep.error) return prep;
  const err = worktreeAdd(["-b", genName, prep.dest, targetBranch]);
  if (err) return err;
  return { path: prep.dest, branch: genName };
}

module.exports = {
  slug,
  SEA_CREATURES,
  suggestName,
  listBranches,
  addWorktree,
};
