/**
 * Test runner — launches the math-question workflow via the orchestrator.
 *
 * Fire-and-forget: the orchestrator sets up infrastructure, launches
 * execution in a Daytona sandbox, and returns immediately.
 *
 * Requires DAYTONA_API_KEY in environment.
 */

import { config } from "../workflows/math-question.js";
import { Orchestrator } from "../packages/core/src/orchestrator.js";

const daytonaApiKey = process.env.DAYTONA_API_KEY;
if (!daytonaApiKey) {
  console.error("Missing required env var: DAYTONA_API_KEY");
  process.exit(1);
}

const orchestrator = new Orchestrator(config, {
  daytonaAuth: { apiKey: daytonaApiKey },
});

try {
  const { runId, sandboxId } = await orchestrator.run();
  console.log(`Run launched: ${runId}`);
  console.log(`Sandbox: ${sandboxId}`);
} catch (err) {
  console.error("Workflow launch failed:", err);
  process.exit(1);
}
