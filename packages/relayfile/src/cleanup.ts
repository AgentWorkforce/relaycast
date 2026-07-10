import type { Bindings } from "./env.js";
import { fetchWorkspaceDOWithBackpressure } from "./workspace-do-backpressure.js";
import { emitMetric } from "./durable-objects/metrics.js";

/**
 * Result of {@link purgeWorkspaceCompletely}: the workspace id, the count of
 * R2 objects deleted, and whether the DO SQLite and D1 metadata were cleaned.
 */
export interface WorkspacePurgeResult {
  workspaceId: string;
  deletedObjects: number;
  doCleaned: boolean;
  metadataCleaned: boolean;
}

const STALE_WORKSPACE_RETENTION_DAYS = 7;
const MAX_WORKSPACES_PER_RUN = 100;
const WORKSPACE_DO_CLEANUP_URL = "https://workspace-do/internal/cleanup";

type WorkspaceRow = {
  workspace_id: string;
};

export async function listStaleWorkspaceIds(
  env: Pick<Bindings, "DB">,
  limit = MAX_WORKSPACES_PER_RUN,
): Promise<string[]> {
  const result = await env.DB.prepare(
    `
      SELECT workspace_id
      FROM workspace_stats
      WHERE last_activity IS NOT NULL
        AND datetime(last_activity) < datetime('now', '-${STALE_WORKSPACE_RETENTION_DAYS} days')
      ORDER BY datetime(last_activity) ASC, workspace_id ASC
      LIMIT ?
    `,
  )
    .bind(limit)
    .all<WorkspaceRow>();

  return (result.results ?? [])
    .map((row) => row.workspace_id.trim())
    .filter(Boolean);
}

export async function deleteWorkspaceContent(
  bucket: R2Bucket,
  workspaceId: string,
): Promise<number> {
  const prefix = `${workspaceId}/`;
  let deleted = 0;
  let cursor: string | undefined;

  do {
    const listing = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  return deleted;
}

export async function purgeWorkspaceState(
  env: Pick<Bindings, "WORKSPACE_DO">,
  workspaceId: string,
): Promise<void> {
  const id = env.WORKSPACE_DO.idFromName(workspaceId);
  const stub = env.WORKSPACE_DO.get(id);
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(WORKSPACE_DO_CLEANUP_URL, {
      method: "POST",
      headers: {
        "X-Workspace-Id": workspaceId,
      },
    }),
    { reason: "durable_object_overloaded" },
  );

  if (!response.ok) {
    throw new Error(
      `workspace cleanup failed for ${workspaceId}: ${response.status}`,
    );
  }
}

export async function deleteWorkspaceMetadata(
  env: Pick<Bindings, "DB">,
  workspaceId: string,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dead_letters WHERE workspace_id = ?").bind(
      workspaceId,
    ),
    env.DB.prepare("DELETE FROM webhook_envelopes WHERE workspace_id = ?").bind(
      workspaceId,
    ),
    env.DB.prepare(
      "DELETE FROM webhook_delivery_dead_letters WHERE workspace_id = ?",
    ).bind(workspaceId),
    env.DB.prepare(
      "DELETE FROM workspace_operations WHERE workspace_id = ?",
    ).bind(workspaceId),
    env.DB.prepare("DELETE FROM sync_refresh_jobs WHERE workspace_id = ?").bind(
      workspaceId,
    ),
    env.DB.prepare("DELETE FROM workspace_stats WHERE workspace_id = ?").bind(
      workspaceId,
    ),
  ]);
}

export async function cleanupStaleWorkspaces(
  env: Pick<Bindings, "CONTENT_BUCKET" | "DB" | "WORKSPACE_DO">,
): Promise<{ cleanedWorkspaces: number; deletedObjects: number }> {
  const workspaceIds = await listStaleWorkspaceIds(env);
  let cleanedWorkspaces = 0;
  let deletedObjects = 0;

  for (const workspaceId of workspaceIds) {
    try {
      deletedObjects += await deleteWorkspaceContent(
        env.CONTENT_BUCKET,
        workspaceId,
      );
      await purgeWorkspaceState(env, workspaceId);
      await deleteWorkspaceMetadata(env, workspaceId);
      cleanedWorkspaces += 1;
    } catch (error) {
      console.error(`Failed to clean stale workspace ${workspaceId}`, error);
    }
  }

  return { cleanedWorkspaces, deletedObjects };
}

/**
 * On-demand, operator-initiated full HARD teardown of a single workspace
 * (R2 object bodies → DO SQLite → D1 metadata, in that order).
 *
 * @param env - Bindings providing the R2 bucket, D1 DB, and workspace DO.
 * @param workspaceId - The workspace to purge completely.
 * @returns A {@link WorkspacePurgeResult} with deleted-object count and
 *   per-store cleanup flags. Best-effort + idempotent: a re-run on an
 *   already-purged workspace is a no-op returning zeroed counts.
 */
// Used by the relayfile `DELETE /v1/workspaces/:workspaceId` admin route,
// which the cloud control plane calls when a user deletes a workspace.
// This is a HARD delete (no tombstone) — the explicit goal is to free
// the expensive resources (R2 object bodies, DO SQLite storage, D1
// metadata) so orphaned workspaces stop accruing storage cost.
//
// Ordering rationale:
//   1. R2 first — the most expensive resource and the one with no other
//      reaper. Paginated/streamed (see deleteWorkspaceContent) so a
//      workspace with millions of objects can't OOM the isolate.
//   2. DO SQLite next — wipes file index/events/operations and clears
//      the DO alarm so the isolate goes dormant.
//   3. D1 metadata last — once R2/DO are gone the metadata rows
//      (dead_letters, webhook_envelopes, workspace_operations,
//      sync_refresh_jobs, workspace_stats) are pure orphans.
//
// Every phase is best-effort + logged: a flaky R2 page or a missing DO
// must not strand the remaining resources. Idempotent: deleting an
// already-purged workspace is a no-op that returns zeroed counts.
export async function purgeWorkspaceCompletely(
  env: Pick<Bindings, "CONTENT_BUCKET" | "DB" | "WORKSPACE_DO">,
  workspaceId: string,
): Promise<WorkspacePurgeResult> {
  const result: WorkspacePurgeResult = {
    workspaceId,
    deletedObjects: 0,
    doCleaned: false,
    metadataCleaned: false,
  };

  try {
    result.deletedObjects = await deleteWorkspaceContent(
      env.CONTENT_BUCKET,
      workspaceId,
    );
    console.log(
      JSON.stringify({
        level: "info",
        msg: "relayfile workspace purge: R2 objects deleted",
        workspace_id: workspaceId,
        deleted_objects: result.deletedObjects,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "relayfile workspace purge: R2 deletion failed",
        workspace_id: workspaceId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  try {
    await purgeWorkspaceState(env, workspaceId);
    result.doCleaned = true;
    console.log(
      JSON.stringify({
        level: "info",
        msg: "relayfile workspace purge: DO storage cleared",
        workspace_id: workspaceId,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "relayfile workspace purge: DO cleanup failed",
        workspace_id: workspaceId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  try {
    await deleteWorkspaceMetadata(env, workspaceId);
    result.metadataCleaned = true;
    console.log(
      JSON.stringify({
        level: "info",
        msg: "relayfile workspace purge: D1 metadata deleted",
        workspace_id: workspaceId,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "relayfile workspace purge: D1 metadata deletion failed",
        workspace_id: workspaceId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  emitMetric("relayfile_workspace_deleted_total", 1, {
    workspace_id: workspaceId,
    do_cleaned: result.doCleaned,
    metadata_cleaned: result.metadataCleaned,
  });
  emitMetric(
    "relayfile_workspace_deleted_objects_total",
    result.deletedObjects,
    { workspace_id: workspaceId },
  );

  console.log(
    JSON.stringify({
      level: "info",
      msg: "relayfile workspace purge: complete",
      workspace_id: workspaceId,
      deleted_objects: result.deletedObjects,
      do_cleaned: result.doCleaned,
      metadata_cleaned: result.metadataCleaned,
    }),
  );

  return result;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const { cleanedWorkspaces } = await cleanupStaleWorkspaces(env);
    console.log(`Cleaned up ${cleanedWorkspaces} stale workspaces`);
  },
};
