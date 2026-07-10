/**
 * Test runner — launches the code-sync-review workflow via the orchestrator.
 *
 * Requires DAYTONA_API_KEY in environment.
 */

import { config } from "../workflows/code-sync-review.js";
import { Orchestrator } from "../packages/core/src/orchestrator.js";

const userId = process.env.USER_ID;
const credentialEncryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
const daytonaApiKey = process.env.DAYTONA_API_KEY;
if (!userId || !credentialEncryptionKey || !daytonaApiKey) {
  console.error("Missing required env var:", !userId ? "USER_ID" : !credentialEncryptionKey ? "CREDENTIAL_ENCRYPTION_KEY" : "DAYTONA_API_KEY");
  process.exit(1);
}

const orchestrator = new Orchestrator(config, {
  daytonaAuth: { apiKey: daytonaApiKey },
});

try {
  const { runId, sandboxId, sandbox } = await orchestrator.run({
    codeSyncDir: process.cwd(),
    userId,
    credentialEncryptionKey,
  });
  console.log(`Run launched: ${runId}`);
  console.log(`Sandbox: ${sandboxId}`);
} catch (err) {
  console.error("Workflow launch failed:", err);
  process.exit(1);
}
