import { logger } from "@/lib/logger";

/**
 * Audit-log entry for a workflow invocation request that came through the
 * lightweight workspace-scoped shim. Mirrors the shape used by
 * {@link recordWorkforceSandboxCreated} so operators can correlate workflow
 * runs back to the caller and the slug they asked for.
 */
export interface WorkflowInvocationAuditEntry {
  workspaceId: string;
  slug: string;
  runId: string;
  requester: string;
  organizationId: string | null;
  outcome:
    | "accepted"
    | "rejected_unknown_slug"
    | "rejected_not_implemented"
    | "rejected_launch_failed";
}

export function recordWorkflowInvocation(
  entry: WorkflowInvocationAuditEntry,
): void {
  void logger.info("Workflow invocation requested", {
    area: "workflow-invocation",
    route: "/api/v1/workspaces/[workspaceId]/workflows/run",
    workspaceId: entry.workspaceId,
    slug: entry.slug,
    runId: entry.runId,
    requester: entry.requester,
    organizationId: entry.organizationId,
    outcome: entry.outcome,
  });
}
