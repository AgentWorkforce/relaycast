import { workflow } from "@relayflows/core";

const CHANNEL = "e2e-per-agent-sandbox";
const RUN_MARKER = `run-${Date.now()}`;

const result = await workflow("e2e-per-agent-sandbox")
  .description("Probe that standalone TS cloud workflows spawn each agent in a distinct Daytona sandbox.")
  .pattern("dag")
  .channel(CHANNEL)
  .maxConcurrency(2)
  .timeout(600_000)
  .agent("claude-probe", {
    cli: "claude",
    role: "Writes the current Daytona sandbox id to sandbox-id-claude.txt.",
    interactive: true,
  })
  .agent("codex-probe", {
    cli: "codex",
    role: "Writes the current Daytona sandbox id to sandbox-id-codex.txt.",
    interactive: true,
  })
  .step("write-claude-sandbox-id", {
    agent: "claude-probe",
    task: [
      "Run this exact shell command from the workflow working directory:",
      "printf 'SANDBOX_ID=%s\\n' \"$DAYTONA_SANDBOX_ID\" > sandbox-id-claude.txt",
      `Then call the relaycast message_post MCP tool with channel="${CHANNEL}" and text="relaycast-ok:claude:${RUN_MARKER}:<DAYTONA_SANDBOX_ID>", replacing <DAYTONA_SANDBOX_ID> with the current DAYTONA_SANDBOX_ID environment value.`,
      "Then print sandbox-id-claude.txt and output DONE.",
    ].join("\n"),
    verification: { type: "output_contains", value: "DONE" },
  })
  .step("write-codex-sandbox-id", {
    agent: "codex-probe",
    task: [
      "Run this exact shell command from the workflow working directory:",
      "printf 'SANDBOX_ID=%s\\n' \"$DAYTONA_SANDBOX_ID\" > sandbox-id-codex.txt",
      `Then call the relaycast message_post MCP tool with channel="${CHANNEL}" and text="relaycast-ok:codex:${RUN_MARKER}:<DAYTONA_SANDBOX_ID>", replacing <DAYTONA_SANDBOX_ID> with the current DAYTONA_SANDBOX_ID environment value.`,
      "Then print sandbox-id-codex.txt and output DONE.",
    ].join("\n"),
    verification: { type: "output_contains", value: "DONE" },
  })
  .step("verify-distinct-sandboxes", {
    type: "deterministic",
    dependsOn: ["write-claude-sandbox-id", "write-codex-sandbox-id"],
    command: [
      "set -e",
      "node --input-type=module <<'NODE'",
      "import { RelayCast } from '@relaycast/sdk';",
      "",
      "const apiKey = process.env.RELAY_API_KEY;",
      "if (!apiKey) throw new Error('RELAY_API_KEY is required to verify relaycast probe messages');",
      `const relay = new RelayCast({ apiKey, baseUrl: process.env.RELAY_BASE_URL });`,
      `const messages = await relay.messages.list(${JSON.stringify(CHANNEL)}, { limit: 100 });`,
      `const marker = ${JSON.stringify(RUN_MARKER)};`,
      "const texts = messages.map((message) => message.text ?? '');",
      "const claude = texts.find((text) => text.startsWith(`relaycast-ok:claude:${marker}:`));",
      "const codex = texts.find((text) => text.startsWith(`relaycast-ok:codex:${marker}:`));",
      "if (!claude) throw new Error('Missing claude relaycast-ok message');",
      "if (!codex) throw new Error('Missing codex relaycast-ok message');",
      "const claudeId = claude.split(':').at(-1);",
      "const codexId = codex.split(':').at(-1);",
      "if (!claudeId) throw new Error('Missing claude sandbox id in relaycast message');",
      "if (!codexId) throw new Error('Missing codex sandbox id in relaycast message');",
      "if (claudeId === codexId) throw new Error(`Expected distinct sandboxes, got ${claudeId}`);",
      "console.log(`CLAUDE_SANDBOX_ID=${claudeId}`);",
      "console.log(`CODEX_SANDBOX_ID=${codexId}`);",
      "NODE",
    ].join("\n"),
    captureOutput: true,
    failOnError: true,
  })
  .run({ cwd: process.cwd() });

if ("status" in result && result.status === "failed") {
  process.exitCode = 1;
}
