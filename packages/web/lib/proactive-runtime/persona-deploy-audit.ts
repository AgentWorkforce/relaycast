import { logger } from "@/lib/logger";

export type PersonaBundleDeploymentAudit = {
  workspaceId: string;
  personaId: string;
  agentId: string;
  deploymentId: string;
  /**
   * `null` under the cold-start runtime model — deploy POST persists
   * metadata only; the sandbox is provisioned later on the first
   * trigger fire via the tick handler.
   */
  sandboxId: string | null;
  requester: string;
  organizationId: string | null;
  watchGlobs: string[];
  scheduleIds: string[];
};

export function recordPersonaBundleDeploymentCreated(
  event: PersonaBundleDeploymentAudit,
): void {
  void logger.info("Persona bundle deployment created", {
    area: "persona-bundle-deploy",
    route: "/api/v1/workspaces/[workspaceId]/deployments",
    workspaceId: event.workspaceId,
    personaId: event.personaId,
    agentId: event.agentId,
    deploymentId: event.deploymentId,
    sandboxId: event.sandboxId,
    requester: event.requester,
    organizationId: event.organizationId,
    watchGlobs: event.watchGlobs,
    scheduleIds: event.scheduleIds,
    outcome: "created",
  });
}
