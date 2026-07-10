/**
 * Hello World workflow — creates a Relaycast workspace and posts a message.
 *
 * Uses a single deterministic step with chained curl calls — no LLM agents needed.
 */

import { WorkflowRunner, InMemoryWorkflowDb } from "@relayflows/core";
import type { RelayYamlConfig } from "@relayflows/core";

const RELAYCAST_API = "https://api.relaycast.dev";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "hello-world",
  description: "Creates a Relaycast workspace and posts Hello World.",
  swarm: {
    pattern: "pipeline",
    maxConcurrency: 1,
    timeoutMs: 60_000,
  },
  agents: [],
  workflows: [
    {
      name: "hello-world-flow",
      steps: [
        {
          name: "create-workspace-and-greet",
          type: "deterministic",
          command: [
            `set -e`,
            `WORKSPACE=$(curl -sf -X POST ${RELAYCAST_API}/v1/workspaces -H 'Content-Type: application/json' -d '{"name":"hello-world-'$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]')'"}')`,
            `API_KEY=$(echo "$WORKSPACE" | jq -r '.data.api_key')`,
            `WORKSPACE_ID=$(echo "$WORKSPACE" | jq -r '.data.workspace_id')`,
            `echo "Workspace created: $WORKSPACE_ID"`,
            `AGENT=$(curl -sf -X POST ${RELAYCAST_API}/v1/agents -H 'Content-Type: application/json' -H "Authorization: Bearer $API_KEY" -d '{"name":"greeter","type":"agent"}')`,
            `TOKEN=$(echo "$AGENT" | jq -r '.data.token')`,
            `echo "Agent registered: greeter"`,
            `MSG=$(curl -sf -X POST ${RELAYCAST_API}/v1/channels/general/messages -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" -d '{"text":"Hello World"}')`,
            `MSG_ID=$(echo "$MSG" | jq -r '.data.id')`,
            `echo "Message sent: $MSG_ID"`,
            `echo "$WORKSPACE"`,
          ].join(" && "),
          captureOutput: true,
        },
      ],
    },
  ],
  errorHandling: {
    strategy: "fail-fast",
  },
};

// Run directly when executed as a script (not imported)
const isMain = process.argv[1]?.endsWith("hello-world.ts") ||
  process.argv[1]?.endsWith("hello-world.js");

if (isMain) {
  const db = new InMemoryWorkflowDb();
  const runner = new WorkflowRunner({ db });
  const result = await runner.execute(config);

  console.log(`Workflow ${result.status} (${result.id})`);

  if (result.status === "failed") {
    console.error(result.error);
    process.exit(1);
  }

  const steps = await db.getStepsByRunId(result.id);
  const step = steps.find((s) => s.stepName === "create-workspace-and-greet");
  if (step?.output) {
    const lastLine = step.output.trim().split("\n").pop()!;
    const { data } = JSON.parse(lastLine);
    console.log(`\nRelaycast workspace_id: ${data.workspace_id}`);
    console.log(`Relaycast api_key: ${data.api_key}`);
  }
}
