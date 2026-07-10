import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  githubCloneJobs,
  workspaceIntegrationDisconnects,
} from "@/lib/db/schema";
import { disconnectIntegrationBackend } from "@/lib/integrations/disconnect-integration-backend";
import { listWorkspaceIntegrations } from "@/lib/integrations/workspace-integrations";
import { logger } from "@/lib/logger";
import {
  deleteRelayWorkspaceRecord,
  purgeRelayfileWorkspace,
} from "@/lib/relay-workspaces";

/**
 * Outcome of {@link deleteWorkspaceCascade}: per-phase counts plus a list of
 * non-fatal `failures` (phase + detail). `relayWorkspaceRowDeleted` is only
 * `true` when the relayfile teardown succeeded and the registry row was
 * actually removed.
 */
export type WorkspaceDeletionSummary = {
  workspaceId: string;
  integrationsRevoked: number;
  integrationsFailed: number;
  relayfileObjectsDeleted: number;
  githubCloneJobsDeleted: number;
  integrationDisconnectTombstonesDeleted: number;
  relayWorkspaceRowDeleted: boolean;
  failures: Array<{ phase: string; detail: string }>;
};

/**
 * Comprehensive HARD-delete cascade for a relay workspace.
 *
 * @param workspaceId - The relay (text) workspace id to fully tear down.
 * @returns A {@link WorkspaceDeletionSummary} with per-phase counts and
 *   any non-fatal `failures`.
 *
 * Ordering/retryability contract: phases run in order (integrations →
 * relayfile → DB rows → registry row). The Phase 4 registry-row delete is
 * intentionally GUARDED on Phase 2 (relayfile teardown) success so a
 * partial failure stays retryable — leaving the row in place keeps the
 * workspace addressable for a later retry instead of stranding DO/R2
 * storage behind a 404. Provider-disconnect and DB-row failures are
 * non-fatal and recorded; a registry-row delete error is rethrown (→ 500).
 */
// Soft-vs-hard: HARD delete (see purgeRelayfileWorkspace for the
// rationale). Every workspace-owned resource is removed:
//
//   1. Provider integrations (Nango/Composio): best-effort revoke via
//      the same disconnectIntegrationBackend service used by
//      `integration disconnect`. A flaky provider revoke is logged and
//      recorded but does NOT block the rest of the cascade — the
//      operator's explicit goal is to free server-side state.
//   2. Relayfile state: DO SQLite + R2 object bodies + D1 metadata, via
//      the relayfile control-plane DELETE endpoint (paginated R2
//      deletion server-side, safe for large workspaces).
//   3. Cloud DB rows keyed by the relay (text) workspace id:
//      - github_clone_jobs
//      - workspace_integration_disconnects (tombstones — pointless once
//        the workspace itself is gone)
//      - workspace_integrations rows are removed by step 1
//        (deleteWorkspaceIntegration); integration_scopes cascade via
//        their FK onDelete:"cascade".
//   4. The relay_workspaces registry row itself, last.
//
// DB row deletes are independently awaited (Drizzle/Neon HTTP has no
// multi-statement transaction handle here); ordering is FK-safe because
// the only FK into these tables (integration_scopes ->
// workspace_integrations) is ON DELETE CASCADE.
//
// Idempotent: a re-run after partial failure re-revokes nothing harmful
// (disconnect is idempotent) and the relayfile endpoint + row deletes
// are no-ops when the data is already gone.
export async function deleteWorkspaceCascade(
  workspaceId: string,
): Promise<WorkspaceDeletionSummary> {
  const summary: WorkspaceDeletionSummary = {
    workspaceId,
    integrationsRevoked: 0,
    integrationsFailed: 0,
    relayfileObjectsDeleted: 0,
    githubCloneJobsDeleted: 0,
    integrationDisconnectTombstonesDeleted: 0,
    relayWorkspaceRowDeleted: false,
    failures: [],
  };

  await logger.info("workspace delete: cascade started", {
    area: "workspace-delete",
    workspaceId,
  });

  // Phase 1 — revoke provider integrations (best-effort, never blocking).
  let integrations: Awaited<ReturnType<typeof listWorkspaceIntegrations>> = [];
  try {
    integrations = await listWorkspaceIntegrations(workspaceId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    summary.failures.push({ phase: "list-integrations", detail });
    await logger.warn("workspace delete: failed to list integrations", {
      area: "workspace-delete",
      workspaceId,
      error: detail,
    });
  }

  for (const integration of integrations) {
    try {
      await disconnectIntegrationBackend({
        workspaceId,
        provider: integration.provider,
        integration,
      });
      summary.integrationsRevoked += 1;
    } catch (error) {
      summary.integrationsFailed += 1;
      const detail = error instanceof Error ? error.message : String(error);
      summary.failures.push({
        phase: `revoke-integration:${integration.provider}`,
        detail,
      });
      await logger.warn("workspace delete: integration revoke failed", {
        area: "workspace-delete",
        workspaceId,
        provider: integration.provider,
        error: detail,
      });
    }
  }

  await logger.info("workspace delete: integrations phase complete", {
    area: "workspace-delete",
    workspaceId,
    revoked: summary.integrationsRevoked,
    failed: summary.integrationsFailed,
  });

  // Phase 2 — relayfile DO/R2/D1 teardown.
  let relayfileTeardownSucceeded = false;
  try {
    const purge = await purgeRelayfileWorkspace(workspaceId);
    summary.relayfileObjectsDeleted = purge.deletedObjects;
    relayfileTeardownSucceeded = true;
    await logger.info("workspace delete: relayfile teardown complete", {
      area: "workspace-delete",
      workspaceId,
      deletedObjects: purge.deletedObjects,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    summary.failures.push({ phase: "relayfile-teardown", detail });
    await logger.error("workspace delete: relayfile teardown failed", {
      area: "workspace-delete",
      workspaceId,
      error: detail,
    });
  }

  // Phase 3 — cloud DB rows keyed by the relay (text) workspace id.
  const db = getDb();

  try {
    const deletedJobs = await db
      .delete(githubCloneJobs)
      .where(eq(githubCloneJobs.workspaceId, workspaceId))
      .returning({ id: githubCloneJobs.id });
    summary.githubCloneJobsDeleted = deletedJobs.length;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    summary.failures.push({ phase: "delete-github-clone-jobs", detail });
    await logger.warn("workspace delete: github_clone_jobs delete failed", {
      area: "workspace-delete",
      workspaceId,
      error: detail,
    });
  }

  try {
    const deletedTombstones = await db
      .delete(workspaceIntegrationDisconnects)
      .where(eq(workspaceIntegrationDisconnects.workspaceId, workspaceId))
      .returning({ connectionId: workspaceIntegrationDisconnects.connectionId });
    summary.integrationDisconnectTombstonesDeleted = deletedTombstones.length;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    summary.failures.push({
      phase: "delete-integration-disconnects",
      detail,
    });
    await logger.warn(
      "workspace delete: workspace_integration_disconnects delete failed",
      { area: "workspace-delete", workspaceId, error: detail },
    );
  }

  // Phase 4 — the registry row itself, last. Only remove it when the
  // relayfile teardown (Phase 2) succeeded: keeping the row when teardown
  // failed preserves retryability — a retry can still address the
  // workspace instead of stranding DO/R2 storage behind a 404.
  if (relayfileTeardownSucceeded) {
    try {
      summary.relayWorkspaceRowDeleted =
        await deleteRelayWorkspaceRecord(workspaceId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      summary.failures.push({ phase: "delete-relay-workspace-row", detail });
      await logger.error("workspace delete: relay_workspaces delete failed", {
        area: "workspace-delete",
        workspaceId,
        error: detail,
      });
      throw error;
    }
  }

  await logger.info("workspace delete: cascade complete", {
    area: "workspace-delete",
    workspaceId,
    integrationsRevoked: summary.integrationsRevoked,
    integrationsFailed: summary.integrationsFailed,
    relayfileObjectsDeleted: summary.relayfileObjectsDeleted,
    githubCloneJobsDeleted: summary.githubCloneJobsDeleted,
    integrationDisconnectTombstonesDeleted:
      summary.integrationDisconnectTombstonesDeleted,
    relayWorkspaceRowDeleted: summary.relayWorkspaceRowDeleted,
    failureCount: summary.failures.length,
  });

  return summary;
}
