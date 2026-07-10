/**
 * E2E test — CLI auth via Daytona connect command.
 *
 * Usage:
 *   npx tsx --env-file=.env tests/cli-auth.ts [provider]
 *
 * Creates a Daytona sandbox, runs the provider CLI interactively via PTY,
 * stores credentials in a persistent volume, then verifies retrieval.
 *
 * Requires DAYTONA_API_KEY in environment.
 */

import { CliAuth } from "../packages/core/src/cli-auth.js";
import { CLI_AUTH_CONFIG } from "@agent-relay/config/cli-auth-config";

const provider = process.argv[2] || "anthropic";

if (!(provider in CLI_AUTH_CONFIG)) {
  console.error(
    `Unknown provider: ${provider}\nSupported: ${Object.keys(CLI_AUTH_CONFIG).join(", ")}`
  );
  process.exit(1);
}

const cliAuth = new CliAuth();

console.log(`Authenticating with provider: ${provider}`);

try {
  // Full auth flow — interactive PTY session via connect command
  const result = await cliAuth.authenticate(provider);

  console.log(`\nAuthentication successful for ${result.provider}`);
  console.log(`Volume: ${result.volumeName}`);

  // Verify retrieval from volume
  console.log("\nVerifying credential retrieval from volume...");
  const retrieved = await cliAuth.getCredentials(provider);
  if (retrieved) {
    console.log(`Retrieved credentials: ${retrieved.length} chars`);
    console.log("Verification: PASS");
  } else {
    console.error("Verification: FAIL — could not retrieve stored credentials");
    process.exit(1);
  }

  // List all authenticated providers
  const metadata = await cliAuth.listAuthenticated();
  if (metadata) {
    console.log("\nAuthenticated providers:");
    for (const [id, info] of Object.entries(metadata.providers)) {
      console.log(`  ${id}: authenticated at ${info.authenticatedAt}`);
    }
  }
} catch (err) {
  console.error("Authentication failed:", err);
  process.exit(1);
}
