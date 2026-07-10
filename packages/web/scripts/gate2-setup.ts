/**
 * Gate 2 setup: seed the dev slack-relay integration credential into relayfile
 * so the bearer-token Gate 2 writeback verification leg can run.
 *
 * The relayfile integration-credential endpoint is HMAC-only, so this routes
 * through cloud-web's canonical signed push path
 * (`seedGate2SlackCredential` → `pushRelayfileIntegrationCredential` →
 * `signRelayfileInternalRequest`) rather than a shell HMAC clone.
 *
 * Required environment:
 *   - RELAYFILE_URL (or RelayfileUrl) — e.g. https://dev.file.agentrelay.com
 *   - RELAYFILE_INTERNAL_HMAC_SECRET — shared internal HMAC secret
 *
 * Optional overrides:
 *   - GATE2_WORKSPACE_ID            (default rw_dev0000)
 *   - GATE2_SLACK_CONNECTION_ID     (default the dev slack-relay connection)
 *   - GATE2_SLACK_PROVIDER_CONFIG_KEY (default slack-relay)
 *
 * Exits non-zero on any seeding failure so the gate fails loud — a silently
 * skipped seed would surface later as a blind Gate 2 401.
 */
import {
  GATE2_DEV_WORKSPACE_ID,
  GATE2_SLACK_CONNECTION_ID,
  GATE2_SLACK_PROVIDER_CONFIG_KEY,
  seedGate2SlackCredential,
} from "../lib/integrations/gate2-setup";

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback) return fallback;
  console.error(`[gate2-setup] missing required env: ${name}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Fail fast with a clear message if the relayfile target/secret is absent,
  // rather than letting the push path throw a less obvious error.
  const relayfileUrl = requireEnv("RELAYFILE_URL", process.env.RelayfileUrl);
  requireEnv("RELAYFILE_INTERNAL_HMAC_SECRET");

  const workspaceId = process.env.GATE2_WORKSPACE_ID ?? GATE2_DEV_WORKSPACE_ID;
  const connectionId =
    process.env.GATE2_SLACK_CONNECTION_ID ?? GATE2_SLACK_CONNECTION_ID;
  const providerConfigKey =
    process.env.GATE2_SLACK_PROVIDER_CONFIG_KEY ??
    GATE2_SLACK_PROVIDER_CONFIG_KEY;

  console.log(
    `[gate2-setup] seeding ${providerConfigKey} credential for ${workspaceId} ` +
      `(connection ${connectionId}) → ${relayfileUrl}`,
  );

  const result = await seedGate2SlackCredential({
    workspaceId,
    connectionId,
    providerConfigKey,
  });

  if (!result.ok) {
    console.error("[gate2-setup] credential seed FAILED", {
      provider: result.provider,
      status: result.status,
      error: result.error,
      responseSnippet: result.responseSnippet,
    });
    process.exit(1);
  }

  console.log(
    `[gate2-setup] credential seed OK (provider ${result.provider}, status ${result.status})`,
  );
}

main().catch((error) => {
  console.error(
    "[gate2-setup] unexpected error",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
