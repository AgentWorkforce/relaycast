import "server-only";

import type { NangoSyncJob } from "@cloud/core/sync/nango-sync-job.js";
import { readWorkerEnv } from "@/lib/aws/runtime";
import { resolveRelayfileCredentialWorkspaceId } from "@/lib/integrations/relayfile-integration-push";

export async function enqueueNangoSyncJob(job: NangoSyncJob): Promise<void> {
  // Single producer chokepoint (router + composio callers): resolve the
  // relayfile workspace the worker should write into. Legacy
  // workspace_integrations rows store the cloud workspace UUID; relayfile
  // mounts are keyed by the bound rw_ id, so an untranslated job writes
  // records into a UUID-named workspace nobody mounts (the /github-only
  // observer gap, second half). Best-effort: a translation failure keeps
  // today's behavior rather than failing the sync.
  if (!job.relayWorkspaceId) {
    try {
      const relayWorkspaceId = await resolveRelayfileCredentialWorkspaceId(job.workspaceId);
      if (relayWorkspaceId && relayWorkspaceId !== job.workspaceId) {
        job = { ...job, relayWorkspaceId };
      }
    } catch (error) {
      console.warn("[nango-sync-queue] relay workspace translation failed; enqueueing untranslated", {
        provider: job.provider,
        workspaceId: job.workspaceId,
        connectionId: job.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const workflow = nangoSyncWorkflowBinding(readWorkerEnv());
  if (!workflow) {
    throw new Error(
      "[nango-sync-workflow] NANGO_SYNC_WORKFLOW binding is not available",
    );
  }

  // Do NOT pass a deterministic `id` — CF Workflows dedup by id, so a fixed key
  // would block re-running the same backfill tuple after completion. Let CF
  // auto-generate the run id instead.
  await workflow.create({ params: job });
}

function nangoSyncWorkflowBinding(
  workerEnv: Record<string, unknown> | undefined,
):
  | { create(o: { id?: string; params?: unknown }): Promise<unknown> }
  | undefined {
  if (!workerEnv) {
    return undefined;
  }
  const binding = workerEnv.NANGO_SYNC_WORKFLOW;
  if (typeof binding === "object" && binding !== null) {
    return binding as {
      create(o: { id?: string; params?: unknown }): Promise<unknown>;
    };
  }
  return undefined;
}
