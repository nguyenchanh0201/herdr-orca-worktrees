#!/usr/bin/env node
const commands = require("../src/commands");
const projects = require("../src/projects");
const { fetchAll } = require("../src/usage");

function parseUsageArgs(args) {
  let only;
  const skip = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--only" && i + 1 < args.length) {
      only = args[++i];
    } else if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length);
    } else if (arg === "--skip" && i + 1 < args.length) {
      skip.push(args[++i]);
    } else if (arg.startsWith("--skip=")) {
      skip.push(arg.slice("--skip=".length));
    }
  }

  return { only, skip };
}

function handleProjects(args) {
  const [sub, ...rest] = args;
  const positional = rest.filter((a) => !a.startsWith("--"));

  switch (sub) {
    case "list":
      return projects.listProjects();
    case "add":
      return projects.addProject(positional[0]);
    case "remove":
      return projects.removeProject(positional[0]);
    case "seed":
      return projects.seedProjects(positional);
    default:
      return { error: sub ? `unknown projects subcommand: ${sub}` : "missing projects subcommand" };
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  const positional = rest.filter((a) => !a.startsWith("--"));
  const target = positional[0];

  let result;
  switch (cmd) {
    case "info":
      result = commands.info(target);
      break;
    case "setup":
      result = commands.setup(target);
      break;
    case "preflight":
      result = commands.preflight(target);
      break;
    case "archive":
      result = commands.archive(target);
      break;
    case "remove":
      result = commands.remove(target, { force });
      break;
    case "projects":
      result = handleProjects(rest);
      break;
    case "clone":
      result = projects.cloneProject(positional[0], positional[1], positional[2]);
      break;
    case "usage":
      result = await fetchAll(parseUsageArgs(rest));
      break;
    default:
      result = { error: cmd ? `unknown command: ${cmd}` : "missing command" };
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e) }) + "\n");
});
