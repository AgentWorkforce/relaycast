import { normalizeWritebackProvider } from "../../../../../lib/integrations/relayfile-integration-push";
import { getWorkspaceIntegrationByProviderAlias } from "../../../../../lib/integrations/workspace-integrations";
import {
  resolveWorkspaceIntegrationIdentity,
  uniqueWorkspaceIds,
} from "../../../../../lib/workspaces/workspace-integration-identity";

export async function dispatchMovedToCloudflare(input: {
  workspaceId: string;
  path: string;
  provider?: string;
}): Promise<boolean> {
  const provider =
    normalizeWritebackProvider(relayfileWritebackProviderSegment(input.path) ?? "") ??
    normalizeWritebackProvider(input.provider ?? "");
  if (!provider) {
    return false;
  }

  const identity = await resolveWorkspaceIntegrationIdentity(input.workspaceId);
  const candidateWorkspaceIds = uniqueWorkspaceIds([
    identity.relayWorkspaceId,
    identity.appWorkspaceId,
    ...identity.candidateWorkspaceIds,
  ]);

  for (const workspaceId of candidateWorkspaceIds) {
    const integration = await getWorkspaceIntegrationByProviderAlias(
      workspaceId,
      provider,
    );
    if (integration?.writebackDispatchVia === "cf") {
      return true;
    }
  }

  return false;
}

export function relayfileWritebackProviderSegment(path: string): string | undefined {
  return path.trim().match(/^\/?([^/]+)/u)?.[1];
}
