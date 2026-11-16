#!/usr/bin/env node
const commands = require("../src/commands");

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const force = rest.includes("--force");
  const target = rest.find((a) => !a.startsWith("--"));

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
    default:
      result = { error: cmd ? `unknown command: ${cmd}` : "missing command" };
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

try {
  main();
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e) }) + "\n");
}
