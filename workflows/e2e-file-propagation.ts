import { workflow } from "@relayflows/core";

const CHANNEL = "e2e-file-propagation";
const RUN_MARKER = `run-${Date.now()}`;
const CLAUDE_FILE = `propagation-claude-${RUN_MARKER}.txt`;
const CODEX_FILE = `propagation-codex-${RUN_MARKER}.txt`;
const CLAUDE_CONTENT = `claude-file-propagation:${RUN_MARKER}`;
const CODEX_CONTENT = `codex-file-propagation:${RUN_MARKER}`;

const result = await workflow("e2e-file-propagation")
  .description("Probe that per-agent sandbox file writes propagate into the orchestrator cwd.")
  .pattern("dag")
  .channel(CHANNEL)
  .maxConcurrency(2)
  .timeout(600_000)
  .agent("claude-writer", {
    cli: "claude",
    preset: "worker",
    role: "Writes a unique propagation marker file to the workflow cwd.",
  })
  .agent("codex-writer", {
    cli: "codex",
    preset: "worker",
    role: "Writes a unique propagation marker file to the workflow cwd.",
  })
  .step("write-claude-file", {
    agent: "claude-writer",
    task: [
      "Run this exact shell command from the workflow working directory:",
      `printf '%s\\n' ${JSON.stringify(CLAUDE_CONTENT)} > ${JSON.stringify(CLAUDE_FILE)}`,
      `cat ${JSON.stringify(CLAUDE_FILE)}`,
      "Then output DONE.",
    ].join("\n"),
    verification: { type: "output_contains", value: "DONE" },
  })
  .step("write-codex-file", {
    agent: "codex-writer",
    task: [
      "Run this exact shell command from the workflow working directory:",
      `printf '%s\\n' ${JSON.stringify(CODEX_CONTENT)} > ${JSON.stringify(CODEX_FILE)}`,
      `cat ${JSON.stringify(CODEX_FILE)}`,
      "Then output DONE.",
    ].join("\n"),
    verification: { type: "output_contains", value: "DONE" },
  })
  .step("verify-propagated-files", {
    type: "deterministic",
    dependsOn: ["write-claude-file", "write-codex-file"],
    command: [
      "set -e",
      `ls ${JSON.stringify(CLAUDE_FILE)} ${JSON.stringify(CODEX_FILE)}`,
      `cat ${JSON.stringify(CLAUDE_FILE)} ${JSON.stringify(CODEX_FILE)}`,
      `grep -qx ${JSON.stringify(CLAUDE_CONTENT)} ${JSON.stringify(CLAUDE_FILE)}`,
      `grep -qx ${JSON.stringify(CODEX_CONTENT)} ${JSON.stringify(CODEX_FILE)}`,
      `echo FILE_PROPAGATION_OK:${RUN_MARKER}`,
    ].join("\n"),
    captureOutput: true,
    failOnError: true,
  })
  .run({ cwd: process.cwd() });

if ("status" in result && result.status === "failed") {
  process.exitCode = 1;
}
