import {
  pushRelayfileIntegrationCredential,
  type RelayfileIntegrationPushResult,
} from "./relayfile-integration-push";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

/**
 * Gate 2 dev-workspace credential seeding.
 *
 * The Gate 2 writeback verification harness (`gate2-verify`) authenticates with
 * a relayfile bearer token, but the relayfile integration-credential endpoint
 * (`PUT /v1/workspaces/:id/integrations/:provider`) is HMAC-only by design — a
 * bearer token cannot satisfy it. Rather than re-implement the HMAC signing in
 * a shell/curl clone (which would drift from the canonical signer), this seeds
 * the credential through cloud-web's existing canonical push path
 * (`pushRelayfileIntegrationCredential` → `signRelayfileInternalRequest`).
 *
 * For a relay-workspace id (`rw_…`) and a slack provider this path performs NO
 * database access: `resolveRelayfileCredentialWorkspaceId` returns a relay id
 * as-is, and the slack branch of `resolveRelayfileCredentialPayload` reads the
 * record fields directly. It therefore only requires `RelayfileUrl` /
 * `RELAYFILE_URL` and `RELAYFILE_INTERNAL_HMAC_SECRET` in the environment.
 */

/** Dev workspace the Gate 2 harness runs writeback verification against. */
export const GATE2_DEV_WORKSPACE_ID = "rw_dev0000";

/** Nango provider config key for the dev slack-relay connection. */
export const GATE2_SLACK_PROVIDER_CONFIG_KEY = "slack-relay";

/** Long-lived dev slack-relay connection id used by the Gate 2 harness. */
export const GATE2_SLACK_CONNECTION_ID =
  "6ff59f0f-a6e3-437b-8378-7ff978681d30";

export type Gate2SlackCredentialSeedOptions = {
  workspaceId?: string;
  connectionId?: string;
  providerConfigKey?: string;
  metadata?: Record<string, unknown>;
  /** Injectable clock for deterministic tests. */
  now?: Date;
};

/**
 * Build the minimal `WorkspaceIntegrationRecord` the canonical push path needs
 * to seed the dev slack-relay credential. Only the fields the push reads
 * (`provider`, `providerConfigKey`, `connectionId`, `metadata`, `updatedAt`,
 * `writebackDispatchVia`, `workspaceId`) are load-bearing; the rest satisfy the
 * record type.
 */
export function buildGate2SlackIntegrationRecord(
  options: Gate2SlackCredentialSeedOptions = {},
): WorkspaceIntegrationRecord {
  const now = options.now ?? new Date();
  const workspaceId = options.workspaceId ?? GATE2_DEV_WORKSPACE_ID;
  const connectionId = options.connectionId ?? GATE2_SLACK_CONNECTION_ID;
  const providerConfigKey =
    options.providerConfigKey ?? GATE2_SLACK_PROVIDER_CONFIG_KEY;

  return {
    id: `gate2-${providerConfigKey}-${workspaceId}`,
    workspaceId,
    // `provider` is normalized to "slack" by `normalizeWritebackProvider`;
    // `providerConfigKey` carries the concrete "slack-relay" config key.
    provider: providerConfigKey,
    name: null,
    connectionId,
    providerConfigKey,
    installationId: null,
    metadata: options.metadata ?? {},
    writebackDispatchVia: "bridge",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Seed the dev slack-relay credential into relayfile via the canonical signed
 * push path. Returns the push result; callers should treat `ok: false` as a
 * hard setup failure (fail loud — a silently-skipped seed produces a blind
 * Gate 2 401).
 */
export async function seedGate2SlackCredential(
  options: Gate2SlackCredentialSeedOptions = {},
): Promise<RelayfileIntegrationPushResult> {
  const record = buildGate2SlackIntegrationRecord(options);
  return pushRelayfileIntegrationCredential(record, {
    updatedAt: record.updatedAt,
  });
}
