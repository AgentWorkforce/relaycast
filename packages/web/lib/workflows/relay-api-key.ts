import { optionalEnv } from "@/lib/env";
import { getRelayWorkspace } from "@/lib/relay-workspaces";

export async function resolveRelayApiKeyForWorkspace(
  relayWorkspaceId: string,
  options?: {
    fallbackRelayApiKey?: string;
    warn?: (message: string) => void;
  },
): Promise<string> {
  const record = await getRelayWorkspace(relayWorkspaceId);
  const relaycastApiKey = record?.relaycastApiKey.trim() ?? "";
  if (relaycastApiKey) {
    return relaycastApiKey;
  }

  const fallbackRelayApiKey = options?.fallbackRelayApiKey ?? (optionalEnv("RELAY_API_KEY") ?? "");
  if (fallbackRelayApiKey) {
    options?.warn?.(
      `[run] Workspace ${relayWorkspaceId} using global RELAY_API_KEY fallback because relay_workspaces has no relaycastApiKey`,
    );
  }

  return fallbackRelayApiKey;
}
