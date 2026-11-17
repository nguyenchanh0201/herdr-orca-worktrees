#!/usr/bin/env node
if (!process.argv.includes("app-server")) process.exit(0);
const readline = require("node:readline");

const mode = process.env.FAKE_CODEX_MODE || "ok";
const delay = Number(process.env.FAKE_CODEX_DELAY || 0);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (mode === "silent") {
    return;
  }

  if (msg.id === 1) {
    const reply = () => send({ jsonrpc: "2.0", id: 1, result: {} });
    if (mode === "slow" && delay > 0) {
      setTimeout(reply, delay);
    } else {
      reply();
    }
    return;
  }

  if (msg.id === 2) {
    if (mode === "error") {
      send({ jsonrpc: "2.0", id: 2, error: { code: -1, message: "not logged in" } });
    } else {
      send({
        jsonrpc: "2.0",
        id: 2,
        result: {
          rateLimits: {
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 },
            secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1800500000 },
          },
        },
      });
    }
  }
});
