import { logger } from "@/lib/logger";

export interface WorkforceSandboxAuditEntry {
  workspaceId: string;
  personaId: string;
  sandboxId: string;
  requester: string;
  organizationId: string | null;
  timeoutSeconds: number;
}

export interface WorkforceSandboxPathTokenAuditEntry {
  workspaceId: string;
  personaId: string;
  agentId: string | null;
  sandboxId: string;
  requester: string;
  paths: string[];
}

export function recordWorkforceSandboxCreated(
  entry: WorkforceSandboxAuditEntry,
): void {
  void logger.info("Workforce sandbox created", {
    area: "workforce-sandbox",
    route: "/api/v1/workspaces/[workspaceId]/sandboxes",
    workspaceId: entry.workspaceId,
    personaId: entry.personaId,
    sandboxId: entry.sandboxId,
    requester: entry.requester,
    organizationId: entry.organizationId,
    timeoutSeconds: entry.timeoutSeconds,
    outcome: "created",
  });
}

export function recordWorkforceSandboxPathTokenMinted(
  entry: WorkforceSandboxPathTokenAuditEntry,
): void {
  void logger.info("Workforce sandbox relayfile path token minted", {
    area: "workforce-sandbox",
    route: "/api/v1/workspaces/[workspaceId]/sandboxes",
    workspaceId: entry.workspaceId,
    personaId: entry.personaId,
    agentId: entry.agentId,
    sandboxId: entry.sandboxId,
    requester: entry.requester,
    paths: entry.paths,
    outcome: "path_token_minted",
  });
}
