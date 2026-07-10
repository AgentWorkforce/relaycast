import {
  isAppWorkspaceId,
  isRelayWorkspaceId,
  readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

export type WorkspaceIntegrationIdentity = {
  requestedWorkspaceId: string;
  appWorkspaceId: string | null;
  relayWorkspaceId: string;
  organizationId: string | null;
  candidateWorkspaceIds: readonly string[];
};

export function uniqueWorkspaceIds(values: Array<string | null | undefined>): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  }
  return ids;
}

/**
 * Cloud routes may be addressed by the app workspace UUID while Relayfile and
 * Nango runtime state is keyed by the bound `rw_*` workspace id. Resolve both
 * sides once at the route edge so status, connect sessions, and runtime
 * dispatch use the same mapping.
 */
export async function resolveWorkspaceIntegrationIdentity(
  workspaceId: string,
): Promise<WorkspaceIntegrationIdentity> {
  const requestedWorkspaceId = workspaceId.trim();
  if (isAppWorkspaceId(requestedWorkspaceId)) {
    const binding = await readAppWorkspaceRelayBinding(requestedWorkspaceId);
    const relayWorkspaceId = binding?.relayWorkspaceId ?? requestedWorkspaceId;
    return {
      requestedWorkspaceId,
      appWorkspaceId: requestedWorkspaceId,
      relayWorkspaceId,
      organizationId: binding?.organizationId ?? null,
      candidateWorkspaceIds: uniqueWorkspaceIds([requestedWorkspaceId, relayWorkspaceId]),
    };
  }

  if (isRelayWorkspaceId(requestedWorkspaceId)) {
    const binding = await resolveAppWorkspaceByRelayWorkspaceId(requestedWorkspaceId);
    return {
      requestedWorkspaceId,
      appWorkspaceId: binding.appWorkspaceId,
      relayWorkspaceId: requestedWorkspaceId,
      organizationId: binding.organizationId,
      candidateWorkspaceIds: uniqueWorkspaceIds([
        requestedWorkspaceId,
        binding.appWorkspaceId,
      ]),
    };
  }

  return {
    requestedWorkspaceId,
    appWorkspaceId: null,
    relayWorkspaceId: requestedWorkspaceId,
    organizationId: null,
    candidateWorkspaceIds: uniqueWorkspaceIds([requestedWorkspaceId]),
  };
}

export async function resolveRelayWorkspaceIdForRuntime(
  workspaceId: string,
): Promise<string> {
  return (await resolveWorkspaceIntegrationIdentity(workspaceId)).relayWorkspaceId;
}

export async function resolveAppWorkspaceIdForRuntime(
  workspaceId: string,
): Promise<string> {
  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  return identity.appWorkspaceId ?? identity.requestedWorkspaceId;
}

export async function resolveAppWorkspaceIdForRelayRuntime(
  workspaceId: string,
): Promise<string | null> {
  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  if (isRelayWorkspaceId(identity.requestedWorkspaceId)) {
    return identity.appWorkspaceId;
  }
  return identity.appWorkspaceId ?? identity.requestedWorkspaceId;
}
