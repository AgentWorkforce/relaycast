/**
 * Math Question workflow — asks Claude a math question.
 * The SDK handles agent spawning and messaging natively.
 */

import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "math-question",
  description: "Asks Claude a math question.",
  swarm: {
    pattern: "pipeline",
    maxConcurrency: 1,
    timeoutMs: 120_000,
    channel: "math-question",
  },
  agents: [
    {
      name: "mathematician",
      cli: "claude",
      role: "Solves math problems",
      interactive: false,
    },
  ],
  workflows: [
    {
      name: "math-question-flow",
      steps: [
        {
          name: "solve-and-post",
          type: "agent",
          agent: "mathematician",
          task: `
Solve this math problem step by step: What is 42 * 37 + 15?
Show your work and provide the final answer.
Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
      ],
    },
  ],
  errorHandling: {
    strategy: "fail-fast",
  },
};
