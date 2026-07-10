/**
 * Shared Story workflow — two writer agents collaborate via a shared volume,
 * then a narrator reads both parts and combines the full story.
 * The SDK handles agent spawning and messaging natively.
 */

import type { RelayYamlConfig } from "@relayflows/core";

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "shared-story",
  description:
    "Two writers collaborate on a story via shared volume, narrator combines the result.",
  swarm: {
    pattern: "pipeline",
    maxConcurrency: 2,
    timeoutMs: 300_000,
    channel: "shared-story",
  },
  agents: [
    {
      name: "writer-a",
      cli: "claude",
      role: "Writes the beginning of a story",
      interactive: false,
    },
    {
      name: "writer-b",
      cli: "claude",
      role: "Writes the ending of a story",
      interactive: false,
    },
    {
      name: "narrator",
      cli: "claude",
      role: "Reads and combines the full story",
      interactive: false,
    },
  ],
  workflows: [
    {
      name: "shared-story-flow",
      steps: [
        {
          name: "write-beginning",
          type: "agent",
          agent: "writer-a",
          task: `
Write the beginning (2-3 paragraphs) of a short story about a robot learning to paint.
Set the scene: the robot discovers paints in an abandoned art studio and makes its first tentative brushstrokes.

Save your story to /shared/part-a.txt by running:
cat > /shared/part-a.txt << 'STORY'
<your story text here>
STORY

Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "write-ending",
          type: "agent",
          agent: "writer-b",
          task: `
Write the ending (2-3 paragraphs) of a short story about a robot learning to paint.
The robot has been practicing and finally creates a painting that moves the humans who see it.
Write a satisfying conclusion about art, creativity, and what it means to create.

Save your story to /shared/part-b.txt by running:
cat > /shared/part-b.txt << 'STORY'
<your story text here>
STORY

Output DONE when complete.
          `.trim(),
          verification: {
            type: "output_contains",
            value: "DONE",
          },
        },
        {
          name: "narrate",
          type: "agent",
          agent: "narrator",
          dependsOn: ["write-beginning", "write-ending"],
          task: `
Read the two story parts from the shared volume:
1. Read /shared/part-a.txt (the beginning)
2. Read /shared/part-b.txt (the ending)

Combine them into one cohesive story. Add a brief transitional sentence between the parts if needed.

Output the full combined story, then output DONE when complete.
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
