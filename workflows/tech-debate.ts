/**
 * Tech Debate workflow — two interactive agents debate a topic,
 * a non-interactive judge picks the winner.
 *
 * Exercises interactive PTY agents with relay messaging (debate pattern).
 */

import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "tech-debate",
  description: "Two agents debate a topic, a judge picks the winner.",
  swarm: {
    pattern: "debate",
    maxConcurrency: 2,
    timeoutMs: 300_000,
    channel: "tech-debate",
  },
  agents: [
    {
      name: "advocate",
      cli: "claude",
      role: "Argues in favor of the position",
      // interactive: true is default — full PTY + relay messaging
    },
    {
      name: "critic",
      cli: "claude",
      role: "Argues against the position",
    },
    {
      name: "judge",
      cli: "claude",
      role: "Evaluates both arguments and declares a winner",
      interactive: false,
    },
  ],
  workflows: [
    {
      name: "tech-debate-flow",
      steps: [
        {
          name: "argue-for",
          type: "agent",
          agent: "advocate",
          task: `
You are debating: "Rust is better than Go for backend services."
You are FOR this position. Make 3 strong arguments in favor.
After stating your arguments, use relay_send to send your key points to "critic".
Then check relay_inbox for any rebuttal and respond to it.
Output /exit when done.
          `.trim(),
          verification: { type: "output_contains", value: "/exit" },
        },
        {
          name: "argue-against",
          type: "agent",
          agent: "critic",
          task: `
You are debating: "Rust is better than Go for backend services."
You are AGAINST this position. Make 3 strong arguments against.
Check relay_inbox for the advocate's points and send a rebuttal via relay_send to "advocate".
Output /exit when done.
          `.trim(),
          verification: { type: "output_contains", value: "/exit" },
        },
        {
          name: "verdict",
          type: "agent",
          agent: "judge",
          dependsOn: ["argue-for", "argue-against"],
          task: `
Read both debate transcripts:
FOR: {{steps.argue-for.output}}
AGAINST: {{steps.argue-against.output}}

Evaluate the arguments on logic, evidence, and persuasiveness.
Declare a winner and explain your reasoning in 2-3 sentences.
Output DONE when complete.
          `.trim(),
          verification: { type: "output_contains", value: "DONE" },
        },
      ],
    },
  ],
  coordination: {
    consensusStrategy: "majority",
  },
  errorHandling: {
    strategy: "fail-fast",
  },
};
