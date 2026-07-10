import {
  CloudWorkspaceRegistry,
  type WorkspaceEntry,
  type WorkspacePermissions,
  type WorkspaceRegistryPersistence,
} from "@cloud/core/workspace/registry.js";
import { optionalEnv } from "@/lib/env";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import {
  createRelayWorkspaceRecord,
  createWorkspaceJoinAccess,
  ensureRelayWorkspace,
  getRelayWorkspace,
} from "@/lib/relay-workspaces";

// Canonical relaycast gateway (relaycast-cloud, agentrelay.com zone). Used when
// RELAYCAST_URL is unset (dev/local/tests); prod sets RELAYCAST_URL via infra.
const DEFAULT_RELAYCAST_URL = "https://cast.agentrelay.com";

export type UnifiedWorkspaceServiceConfig = {
  relaycastUrl: string;
  relayfileUrl: string;
  relayauthUrl: string;
  relayAuthApiKey: string;
};

export function resolveConfiguredRelaycastUrl(): string | undefined {
  return optionalEnv("RELAYCAST_URL")
    ?? optionalEnv("RELAYCAST_API_URL");
}

export function resolveRelaycastUrl(): string {
  return resolveConfiguredRelaycastUrl() ?? DEFAULT_RELAYCAST_URL;
}

function resolveRelayauthUrl(): string {
  const url = optionalEnv("RelayauthUrl")
    ?? optionalEnv("RELAYAUTH_URL")
    ?? optionalEnv("RELAYAUTH_API_URL");
  if (!url) {
    throw new Error("RelayauthUrl not configured — check infra/web.ts environment");
  }
  return url;
}

export function resolveUnifiedWorkspaceServiceConfig(): UnifiedWorkspaceServiceConfig {
  const { relayfileUrl, relayAuthApiKey } = resolveRelayfileConfig();
  return {
    relaycastUrl: resolveRelaycastUrl(),
    relayfileUrl,
    relayauthUrl: resolveRelayauthUrl(),
    relayAuthApiKey,
  };
}

const persistence: WorkspaceRegistryPersistence = {
  async create(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    await ensureRelayWorkspace(entry.id, entry.permissions);
    const record = await createRelayWorkspaceRecord({
      id: entry.id,
      ownerUserId: entry.createdBy,
      name: entry.name ?? entry.id,
      relaycastApiKey: entry.relaycastApiKey,
      permissions: entry.permissions,
    });

    return {
      id: record.id,
      name: record.name,
      relaycastApiKey: record.relaycastApiKey,
      relayfileWorkspaceId: record.id,
      relayauthWorkspaceId: record.id,
      createdAt: record.createdAt.toISOString(),
      createdBy: record.ownerUserId,
      permissions: record.permissions,
    };
  },

  async get(id: string): Promise<WorkspaceEntry | null> {
    const record = await getRelayWorkspace(id);
    if (!record) {
      return null;
    }

    return {
      id: record.id,
      name: record.name,
      relaycastApiKey: record.relaycastApiKey,
      relayfileWorkspaceId: record.id,
      relayauthWorkspaceId: record.id,
      createdAt: record.createdAt.toISOString(),
      createdBy: record.ownerUserId,
      permissions: record.permissions,
    };
  },
};

export function createCloudWorkspaceRegistry() {
  const serviceConfig = resolveUnifiedWorkspaceServiceConfig();
  const registry = new CloudWorkspaceRegistry(
    serviceConfig.relaycastUrl,
    serviceConfig.relayfileUrl,
    serviceConfig.relayAuthApiKey,
    {
      relayauthBaseUrl: serviceConfig.relayauthUrl,
      persistence,
      joinAccessFactory: async ({ entry, agentName, permissions, requestedScopes }) =>
        createWorkspaceJoinAccess({
          workspaceId: entry.id,
          agentName,
          permissions,
          requestedScopes,
        }),
    },
  );

  return { registry, serviceConfig };
}

export function formatWorkspaceResponse(
  entry: WorkspaceEntry,
  serviceConfig: Pick<UnifiedWorkspaceServiceConfig, "relayfileUrl" | "relayauthUrl">,
  options?: { includePermissions?: boolean },
) {
  return {
    workspaceId: entry.id,
    relaycastApiKey: entry.relaycastApiKey,
    relayfileUrl: serviceConfig.relayfileUrl,
    relayauthUrl: serviceConfig.relayauthUrl,
    joinCommand: `agent-relay on <cli> --workspace ${entry.id}`,
    createdAt: entry.createdAt,
    ...(entry.name ? { name: entry.name } : {}),
    ...(options?.includePermissions ? { permissions: entry.permissions } : {}),
  };
}

export function hasWorkspaceOwnerAccess(entry: WorkspaceEntry, userId: string): boolean {
  return entry.createdBy === userId;
}

export function mergeJoinPermissions(
  storedPermissions: WorkspacePermissions,
  override?: Partial<WorkspacePermissions>,
): WorkspacePermissions {
  return {
    ignored: [...new Set([...storedPermissions.ignored, ...(override?.ignored ?? [])])].sort(),
    readonly: [...new Set([...storedPermissions.readonly, ...(override?.readonly ?? [])])].sort(),
  };
}
