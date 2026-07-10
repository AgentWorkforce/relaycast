/**
 * Test runner — launches the code-sync workflow via the orchestrator.
 *
 * 1. Syncs local project code to the sandbox (tar upload + git baseline)
 * 2. Launches the workflow (agents operate on the code)
 * 3. After workflow completes, syncs changes back (git patch download + apply)
 *
 * Requires DAYTONA_API_KEY in environment.
 */

import { config } from "../workflows/code-sync.js";
import { Orchestrator } from "../packages/core/src/orchestrator.js";

const userId = process.env.USER_ID;
const credentialEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
if (!userId || !credentialEncryptionKey) {
  console.error("Missing required env var:", !userId ? "USER_ID" : "CREDENTIAL_ENCRYPTION_KEY");
  process.exit(1);
}

const daytonaApiKey = process.env.DAYTONA_API_KEY;
if (!daytonaApiKey) {
  console.error("Missing required env var: DAYTONA_API_KEY");
  process.exit(1);
}

const orchestrator = new Orchestrator(config, {
  daytonaAuth: { apiKey: daytonaApiKey },
});

try {
  // Launch workflow with code-sync.
  const { runId, sandboxId, sandbox } = await orchestrator.run({
    codeSyncDir: process.cwd(),
    userId,
    credentialEncryptionKey,
  });
  console.log(`Run launched: ${runId}`);
  console.log(`Sandbox: ${sandboxId}`);

  // After workflow completes, sync changes back:
  // const result = await orchestrator.syncBack(sandbox, process.cwd(), "/project");
  // console.log(`Sync back: ${JSON.stringify(result)}`);
} catch (err) {
  console.error("Workflow launch failed:", err);
  process.exit(1);
}
