import "server-only";

import { markProviderOAuthConnected } from "@cloud/core/provider-readiness.js";
import { logger } from "@/lib/logger";
import {
  getNangoConnectionDetails,
  getProviderConfigKey,
  probeNangoConnectionLiveness,
} from "@/lib/integrations/nango-service";
import {
  isWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { readWorkspaceIdFromAuthPayload } from "@/lib/integrations/nango-webhook-router";
import {
  findWorkspaceIntegrationByConnection,
  getWorkspaceIntegration,
  insertWorkspaceIntegrationIfAbsent,
  replaceWorkspaceIntegrationConnectionIfStale,
} from "@/lib/integrations/workspace-integrations";

// Operator-facing "adopt" flow: bind an existing Nango connection to the
// `(workspaceId, provider)` slot atomically, without re-running OAuth. The
// operator has already minted the connection out-of-band (Nango UI, third-
// party flow), and just wants cloud to start routing sync webhooks for it.
//
// Safety properties:
//
//   * The Nango connection must exist upstream. Adopting a connectionId
//     Nango doesn't know about would leave a row that no webhook can ever
//     reach.
//   * The connection's end-user/workspace tag must match the path's
//     workspaceId. Adoption is not a cross-workspace move; the operator is
//     telling cloud "this connection already belongs to this workspace —
//     please notice." Mismatch returns 409 with both ids so the operator
//     can choose between fixing the connection's tags or pointing at the
//     correct workspace.
//   * If a row already exists for this slot and points at a *different*
//     connectionId, we must not silently trample it. Probe upstream first;
//     only replace when Nango reports the existing connection is "gone"
//     (HTTP 404). For "alive" or "unknown" (transient 5xx / stale secret
//     key), refuse and tell the operator to disconnect first. This mirrors
//     the conservative liveness check that `selfHealMissingWorkspace
//     Integration` uses for self-healing the same conflict on inbound sync
//     webhooks — we want the two paths to agree on what "stale" means.
//   * The replace path is a CAS on `expectedConnectionId`, so two racing
//     adopt calls cannot clobber each other; the loser falls through to
//     `live_or_unknown` (existing already changed to something new).
//   * `markProviderOAuthConnected` is called on success so
//     `/integrations/{provider}/status` reports `oauth.connected: true`
//     and the readiness blob is seeded the same way the auth webhook
//     would have done.

export type AdoptIntegrationInput = {
  workspaceId: string;
  provider: WorkspaceIntegrationProvider;
  connectionId: string;
  providerConfigKey?: string | null;
};

export type AdoptIntegrationResult =
  | {
      ok: true;
      connectionId: string;
      replacedConnectionId?: string;
    }
  | {
      ok: false;
      code:
        | "connection_not_found"
        | "workspace_mismatch"
        | "existing_connection_live_or_unknown";
      message: string;
      // Mismatch fields:
      pathWorkspaceId?: string;
      connectionWorkspaceId?: string;
      // Conflict fields:
      existingConnectionId?: string;
      existingLiveness?: "alive" | "unknown";
    };

export async function adoptIntegrationConnection(
  input: AdoptIntegrationInput,
): Promise<AdoptIntegrationResult> {
  const { workspaceId, provider, connectionId } = input;
  // Default to the conventional `-relay` providerConfigKey when the caller
  // didn't pin one. This matches what the CLI connect-link path does and
  // ensures `getNangoConnectionDetails` queries the right Nango integration
  // when the connection lives under a non-default key.
  const providerConfigKey =
    (input.providerConfigKey?.trim() || null) ??
    (isWorkspaceIntegrationProvider(provider)
      ? getProviderConfigKey(provider)
      : null);

  const details = await getNangoConnectionDetails(connectionId, providerConfigKey);
  if (!details?.payload) {
    await logger.warn(
      "Integration adopt rejected: Nango has no record of the supplied connectionId",
      {
        area: "integration-adopt",
        workspaceId,
        provider,
        connectionId,
        providerConfigKey,
      },
    );
    return {
      ok: false,
      code: "connection_not_found",
      message:
        `Nango has no record of connection ${connectionId}. Verify the connectionId and providerConfigKey, or mint a fresh connection.`,
    };
  }

  // Verify the connection's tagged workspace matches the URL path. Adoption
  // is intentionally NOT a cross-workspace move — if the tags say a
  // different workspace owns this connection, the operator must reconcile
  // first (either fix the connection's end-user metadata in Nango or
  // target the correct workspace path).
  //
  // Escape hatch: an operator who has already authenticated against this
  // workspace (auth check already passed) can override the end-user tag by
  // setting `metadata.workspace_id` on the Nango connection to the target
  // workspaceId. Because only someone with the Nango secret key can set
  // metadata, this is a controlled admin-only escape valve for cases where the
  // end-user tag was assigned to the wrong workspace at connection-creation time.
  const connectionWorkspaceId = readWorkspaceIdFromAuthPayload(details.payload);
  const metadataWorkspaceId = (() => {
    const meta = details.payload["metadata"];
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const m = meta as Record<string, unknown>;
      const v = m["workspace_id"] ?? m["workspaceId"];
      return typeof v === "string" ? v.trim() || null : null;
    }
    return null;
  })();
  const metadataOverridesTag = metadataWorkspaceId === workspaceId;
  if (connectionWorkspaceId && connectionWorkspaceId !== workspaceId && !metadataOverridesTag) {
    await logger.warn(
      "Integration adopt rejected: Nango connection belongs to a different workspace",
      {
        area: "integration-adopt",
        pathWorkspaceId: workspaceId,
        connectionWorkspaceId,
        provider,
        connectionId,
        providerConfigKey,
      },
    );
    return {
      ok: false,
      code: "workspace_mismatch",
      message:
        `Connection ${connectionId} is tagged for workspace ${connectionWorkspaceId}, not ${workspaceId}. Adopt the connection from that workspace instead.`,
      pathWorkspaceId: workspaceId,
      connectionWorkspaceId,
    };
  }
  if (metadataOverridesTag) {
    await logger.info(
      "Integration adopt: metadata workspace_id overrides end-user tag — proceeding with adoption",
      {
        area: "integration-adopt",
        pathWorkspaceId: workspaceId,
        connectionWorkspaceId,
        metadataWorkspaceId,
        provider,
        connectionId,
        providerConfigKey,
      },
    );
  }

  // Try the atomic insert first. If no row exists, we're done in one step.
  const insertResult = await insertWorkspaceIntegrationIfAbsent({
    workspaceId,
    provider,
    connectionId,
    providerConfigKey,
    installationId: details.installationId ?? null,
    metadata: details.payload,
  });

  if (insertResult.inserted) {
    await markProviderOAuthConnected({
      workspaceId,
      provider,
      connectionId,
      providerConfigKey: providerConfigKey ?? "",
    });
    await logger.info("Integration adopt inserted fresh workspace_integrations row", {
      area: "integration-adopt",
      workspaceId,
      provider,
      connectionId,
      providerConfigKey,
    });
    return { ok: true, connectionId };
  }

  const existing = insertResult.existing ??
    (await getWorkspaceIntegration(workspaceId, provider));

  // Idempotent case: the slot already points at exactly the connection we
  // were asked to adopt. Treat as success and refresh the readiness blob
  // so callers always see a fresh oauth.connectedAt timestamp.
  if (existing && existing.connectionId === connectionId) {
    await markProviderOAuthConnected({
      workspaceId,
      provider,
      connectionId,
      providerConfigKey: providerConfigKey ?? existing.providerConfigKey ?? "",
    });
    await logger.info(
      "Integration adopt idempotent: row already pointed at the supplied connection",
      {
        area: "integration-adopt",
        workspaceId,
        provider,
        connectionId,
        providerConfigKey,
      },
    );
    return { ok: true, connectionId };
  }

  // Conflict path: the slot points at a different connectionId. Refuse to
  // overwrite unless we can prove upstream that the existing connection is
  // dead. The probe distinguishes a definitive Nango 404 ("gone") from
  // indeterminate states (401/5xx/network = "unknown"), and we only replace
  // on "gone" — replacing on "unknown" risks stomping a live tenant when
  // Nango is briefly unreachable. This matches the conservative posture in
  // selfHealMissingWorkspaceIntegration.
  if (!existing) {
    // Insert reported a conflict but no row exists at (workspaceId, provider,
    // name). Because `insertWorkspaceIntegrationIfAbsent` now uses an
    // untargeted `ON CONFLICT DO NOTHING`, the conflict can fire on
    // `providerConnectionUnique (provider, connection_id)` instead of the
    // (workspaceId, provider) default index — i.e. a DIFFERENT slot already
    // binds this exact connectionId. A retry can never clear that, so look up
    // the conflicting slot and return an actionable error naming where it
    // lives instead of the misleading "race, retry" loop.
    const boundElsewhere = await findWorkspaceIntegrationByConnection(
      provider,
      connectionId,
    );
    if (boundElsewhere) {
      await logger.warn(
        "Integration adopt blocked: connectionId already bound to another slot",
        {
          area: "integration-adopt",
          workspaceId,
          provider,
          connectionId,
          boundWorkspaceId: boundElsewhere.workspaceId,
          boundName: boundElsewhere.name,
          providerConfigKey,
        },
      );
      return {
        ok: false,
        code: "existing_connection_live_or_unknown",
        message:
          `Connection ${connectionId} is already bound to workspace ` +
          `${boundElsewhere.workspaceId}` +
          `${boundElsewhere.name ? ` (name="${boundElsewhere.name}")` : ""}` +
          `. Disconnect it from that slot first, then re-run adopt.`,
        existingConnectionId: connectionId,
      };
    }

    // Genuine vanished-row race: the insert saw a conflict but the row was
    // deleted before we could re-read it (tight race with
    // deleteWorkspaceIntegration). Treat as unknown; the operator can retry.
    await logger.warn(
      "Integration adopt race: insert reported conflict but row no longer present",
      {
        area: "integration-adopt",
        workspaceId,
        provider,
        connectionId,
        providerConfigKey,
      },
    );
    return {
      ok: false,
      code: "existing_connection_live_or_unknown",
      message:
        "Adoption raced with a concurrent change to this workspace integration. Retry the adopt command.",
      existingLiveness: "unknown",
    };
  }

  const liveness = await probeNangoConnectionLiveness(
    existing.connectionId,
    existing.providerConfigKey ?? providerConfigKey,
  );

  if (liveness !== "gone") {
    await logger.warn(
      "Integration adopt refused: existing connection is still live or its state is indeterminate",
      {
        area: "integration-adopt",
        workspaceId,
        provider,
        connectionId,
        existingConnectionId: existing.connectionId,
        existingLiveness: liveness,
        providerConfigKey,
      },
    );
    return {
      ok: false,
      code: "existing_connection_live_or_unknown",
      message:
        liveness === "alive"
          ? `Workspace ${workspaceId} already has a live ${provider} connection (${existing.connectionId}). Disconnect it first, then re-run adopt.`
          : `Cannot verify the state of the existing ${provider} connection (${existing.connectionId}) — Nango returned an indeterminate response. Disconnect the existing connection first, then re-run adopt.`,
      existingConnectionId: existing.connectionId,
      existingLiveness: liveness,
    };
  }

  const replaced = await replaceWorkspaceIntegrationConnectionIfStale({
    workspaceId,
    provider,
    connectionId,
    providerConfigKey,
    installationId: details.installationId ?? null,
    metadata: details.payload,
    expectedConnectionId: existing.connectionId,
  });

  if (!replaced) {
    // CAS lost — another writer changed the row between probe and replace.
    // Don't retry: the state we'd be replacing is no longer what we
    // verified as gone. The operator can re-run; on retry either the row
    // is fresh (insert path) or the new connectionId already matches
    // (idempotent path).
    await logger.warn(
      "Integration adopt CAS lost: another writer changed the row between probe and replace",
      {
        area: "integration-adopt",
        workspaceId,
        provider,
        connectionId,
        expectedConnectionId: existing.connectionId,
        providerConfigKey,
      },
    );
    return {
      ok: false,
      code: "existing_connection_live_or_unknown",
      message:
        "Adoption raced with a concurrent change to this workspace integration. Retry the adopt command.",
      existingConnectionId: existing.connectionId,
      existingLiveness: "unknown",
    };
  }

  await markProviderOAuthConnected({
    workspaceId,
    provider,
    connectionId,
    providerConfigKey: providerConfigKey ?? "",
  });
  await logger.info("Integration adopt replaced stale workspace_integrations row", {
    area: "integration-adopt",
    workspaceId,
    provider,
    connectionId,
    replacedConnectionId: existing.connectionId,
    providerConfigKey,
  });
  return {
    ok: true,
    connectionId,
    replacedConnectionId: existing.connectionId,
  };
}
