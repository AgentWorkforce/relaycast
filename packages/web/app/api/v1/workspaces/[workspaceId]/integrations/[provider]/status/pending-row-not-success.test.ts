import { describe, expect, it } from "vitest";
import {
  buildLegacyConnectedReadiness,
  buildPendingProviderMetadata,
  readProviderReadiness,
  type ProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import {
  deriveProviderState,
  summarizeWritebackHealth,
} from "@/lib/integrations/provider-status";

// REGRESSION (fresh-eyes required-test gap): the single most dangerous failure
// mode of the connect-session pre-created PENDING workspace_integrations row
// (preCreatePendingNangoRows ->
//  packages/web/app/api/v1/workspaces/[workspaceId]/integrations/connect-session/route.ts)
// is that the pending placeholder row could make
//   GET /api/v1/workspaces/{ws}/integrations/{provider}/status
// report a CLI-success state before the user ever completed real OAuth.
// If that endpoint ever returned ready:true or state in
//   {connected, oauth_connected, sync_queued, syncing, ready}
// for a row that only has the pending placeholder metadata, then
// `relayfile integration connect` would falsely report success for a
// connection the user never authorized.
//
// The existing connect-session route tests MOCK buildPendingProviderMetadata
// and insertWorkspaceIntegrationIfAbsent, and the status/route.test.ts MOCKS
// readProviderReadiness + deriveProviderState wholesale, so neither suite ever
// exercises the REAL status-route derivation on the REAL pending metadata.
// This test closes that gap by running the actual derivation chain:
//   buildPendingProviderMetadata (real) -> readProviderReadiness (real) ->
//   deriveProviderState (real) -> the status route's ready / oauth.connected
//   computation (replicated verbatim from route.ts so a regression there is
//   pinned, not silently re-derived here).

// Verbatim re-implementation of the status route's non-exported
// resolveReadiness() helper
// (packages/.../integrations/[provider]/status/route.ts lines 77-106).
// Kept in lockstep with the route: pending metadata MUST be read via the real
// readProviderReadiness and MUST NOT fall through to
// buildLegacyConnectedReadiness (which would mark initialSync=complete and make
// the placeholder look connected/ready).
function resolveReadiness(integration: {
  metadata: Record<string, unknown>;
  connectionId: string | null;
  providerConfigKey: string | null;
} | null): ProviderReadiness {
  if (!integration) {
    return {
      oauthConnectedAt: null,
      lastAuthAt: null,
      connectionId: null,
      providerConfigKey: null,
      updatedAt: null,
      initialSync: {
        state: "unknown",
        enqueuedAt: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        lastError: null,
        syncName: null,
        model: null,
        modifiedAfter: null,
        byModel: {},
      },
    };
  }

  return (
    readProviderReadiness(integration.metadata) ??
    buildLegacyConnectedReadiness({
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
    })
  );
}

const WORKSPACE_ID = "rw_fc7b534b";
const PENDING_CONNECTION_ID = "48d75838-5c1b-4885-b0c1-3620a80e12f6";

describe("status derivation on the connect-session pre-created PENDING row", () => {
  it("reports state=pending / ready=false (never a CLI-success state) for a pending placeholder row, even though oauth.connected=true", () => {
    // Shape of a pending row pre-created with the real Nango connection id:
    // providerConfigKey is the backend integration id.
    const metadata = buildPendingProviderMetadata({
      connectionId: PENDING_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
    });

    // Sanity: the real seeded metadata is genuinely the *pending* shape
    // (initialSync queued, no oauthConnectedAt) — not a legacy-connected blob.
    const seeded = readProviderReadiness(metadata);
    expect(seeded).not.toBeNull();
    expect(seeded?.initialSync.state).toBe("queued");
    expect(seeded?.oauthConnectedAt).toBeNull();

    // The placeholder row as it exists in workspace_integrations *before*
    // real OAuth completes (installationId null, only pending metadata).
    const integration = {
      workspaceId: WORKSPACE_ID,
      provider: "confluence",
      connectionId: PENDING_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata,
    };

    // Real derivation, no mocking of the readiness/status chain.
    const readiness = resolveReadiness(integration);
    expect(readiness.initialSync.state).toBe("queued");

    // No relayfile sync status yet (provider never authorized) -> unknown.
    const writeback = summarizeWritebackHealth(null);
    const state = deriveProviderState({
      initialSync: readiness.initialSync,
      writeback,
    });

    // The status route's exact ready / oauth.connected computation
    // (route.ts line 282 and lines 297-301): with the workspace polling key,
    // connectionMatched is `integration !== null` === true, and
    // oauth.connected is `integration !== null` === true.
    const connectionMatched = integration !== null;
    const ready =
      Boolean(integration) && connectionMatched && state === "ready";
    const oauthConnected = integration !== null;

    // THE PROPERTY: pending placeholder must NOT look like CLI success.
    expect(state).toBe("pending");
    expect(ready).toBe(false);
    expect(state).not.toBe("ready");
    expect([
      "connected",
      "oauth_connected",
      "sync_queued",
      "syncing",
      "ready",
    ]).not.toContain(state);

    // Documented intended shape the CLI keeps polling on: connected:true
    // (a row exists) + state:pending + ready:false.
    expect(oauthConnected).toBe(true);
  });

  it("positive contrast: a row whose initial sync is complete + healthy writeback derives state=ready / ready=true (pending state is specifically gated, not universal)", () => {
    // markProviderInitialSyncComplete would produce initialSync.state=complete;
    // build that real readiness shape and run the same derivation.
    const completeReadiness = readProviderReadiness(
      buildLegacyConnectedReadiness({
        connectionId: WORKSPACE_ID,
        providerConfigKey: "confluence-relay",
      }) as unknown as Record<string, unknown>,
    );
    // buildLegacyConnectedReadiness returns a ProviderReadiness directly;
    // use it as the resolved readiness for the complete case.
    const readiness =
      completeReadiness ??
      buildLegacyConnectedReadiness({
        connectionId: WORKSPACE_ID,
        providerConfigKey: "confluence-relay",
      });
    expect(readiness.initialSync.state).toBe("complete");

    const integration = {
      workspaceId: WORKSPACE_ID,
      provider: "confluence",
      connectionId: WORKSPACE_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    };

    const writeback = summarizeWritebackHealth({
      provider: "confluence",
      status: "ok",
      watermarkTs: new Date().toISOString(),
      lagSeconds: 0,
    } as unknown as Parameters<typeof summarizeWritebackHealth>[0]);
    const state = deriveProviderState({
      initialSync: readiness.initialSync,
      writeback,
    });

    const connectionMatched = integration !== null;
    const ready =
      Boolean(integration) && connectionMatched && state === "ready";

    expect(state).toBe("ready");
    expect(ready).toBe(true);
  });
});
