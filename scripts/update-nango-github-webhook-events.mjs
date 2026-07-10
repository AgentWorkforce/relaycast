#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const outputPath = "nango-integrations/github-relay/shared/webhook-events.ts";

run("node", ["scripts/generate-nango-github-webhook-events.mjs"]);

const status = run("git", ["status", "--porcelain", "--", outputPath], {
  capture: true,
}).stdout.trim();

if (!status) {
  console.log(`${outputPath} already matches @relayfile/adapter-github.`);
  process.exit(0);
}

run("git", ["add", outputPath]);
run("git", [
  "commit",
  "-m",
  "chore(nango): update generated GitHub webhook events",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture && result.stderr) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }
  return {
    stdout: result.stdout ?? "",
  };
}
