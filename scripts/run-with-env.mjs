#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/run-with-env.mjs <command> [args...]");
  process.exit(1);
}

console.log(`AWS_PROFILE=${process.env.AWS_PROFILE ?? ""}`);

const child = spawn(command, args, {
  env: process.env,
  stdio: "inherit",
});

const forwardSignals = ["SIGINT", "SIGTERM", "SIGHUP"];

for (const signal of forwardSignals) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
