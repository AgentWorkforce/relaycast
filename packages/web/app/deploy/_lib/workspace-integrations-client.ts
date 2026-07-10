import { toAppPath } from "@/lib/app-path";
import type { IntegrationState, PersonaIntegrationSummary } from "./types";

export interface WorkspaceIntegrationListEntry {
  provider: string;
  providerConfigKey: string | null;
  status: string;
  connectionId?: string;
}

export async function fetchWorkspaceIntegrations(
  workspaceId: string,
): Promise<WorkspaceIntegrationListEntry[]> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`),
    {
      cache: "no-store",
      credentials: "include",
    },
  );
  if (!response.ok) {
    throw new Error("Failed to load workspace integrations.");
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload.filter(isWorkspaceIntegrationListEntry) : [];
}

export function connectedIntegrationStatesFromList(
  integrations: PersonaIntegrationSummary[],
  entries: WorkspaceIntegrationListEntry[],
): Record<string, IntegrationState> {
  return Object.fromEntries(
    integrations.flatMap((integration) => {
      const connected = entries.find((entry) => (
        entry.provider === integration.provider &&
        typeof entry.connectionId === "string" &&
        entry.connectionId.trim().length > 0 &&
        entry.status !== "error"
      ));
      if (!connected?.connectionId) return [];

      return [[
        integration.provider,
        {
          provider: integration.provider,
          state: "connected" as const,
          connectionId: connected.connectionId,
        },
      ]];
    }),
  );
}

function isWorkspaceIntegrationListEntry(value: unknown): value is WorkspaceIntegrationListEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    (record.providerConfigKey === null || typeof record.providerConfigKey === "string") &&
    typeof record.status === "string" &&
    (record.connectionId === undefined || typeof record.connectionId === "string")
  );
}
