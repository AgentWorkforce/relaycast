import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELAY_WORKSPACE_ID_PATTERN = /^rw_[A-Za-z0-9_-]+$/;

export type AppWorkspaceBinding = {
  appWorkspaceId: string | null;
  organizationId: string | null;
};

export type AppWorkspaceRelayBinding = {
  appWorkspaceId: string;
  organizationId: string;
  relayWorkspaceId: string | null;
};

export function isRelayWorkspaceId(value: string): boolean {
  return RELAY_WORKSPACE_ID_PATTERN.test(value.trim());
}

export function isAppWorkspaceId(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

export async function resolveAppWorkspaceByRelayWorkspaceId(
  relayWorkspaceId: string,
): Promise<AppWorkspaceBinding> {
  const normalized = relayWorkspaceId.trim();
  if (!normalized) {
    return { appWorkspaceId: null, organizationId: null };
  }

  const [row] = await getDb()
    .select({
      appWorkspaceId: workspaces.id,
      organizationId: workspaces.organizationId,
    })
    .from(workspaces)
    .where(eq(workspaces.relayWorkspaceId, normalized))
    .limit(1);

  return {
    appWorkspaceId: row?.appWorkspaceId ?? null,
    organizationId: row?.organizationId ?? null,
  };
}

export async function readBoundRelayWorkspaceId(
  appWorkspaceId: string,
): Promise<string | null> {
  const binding = await readAppWorkspaceRelayBinding(appWorkspaceId);
  const value = binding?.relayWorkspaceId?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export async function readAppWorkspaceRelayBinding(
  appWorkspaceId: string,
): Promise<AppWorkspaceRelayBinding | null> {
  const normalized = appWorkspaceId.trim();
  if (!isAppWorkspaceId(normalized)) return null;

  const [row] = await getDb()
    .select({
      appWorkspaceId: workspaces.id,
      organizationId: workspaces.organizationId,
      relayWorkspaceId: workspaces.relayWorkspaceId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, normalized))
    .limit(1);

  if (!row) return null;

  const relayWorkspaceId = row.relayWorkspaceId?.trim() ?? "";
  return {
    appWorkspaceId: row.appWorkspaceId,
    organizationId: row.organizationId,
    relayWorkspaceId: relayWorkspaceId.length > 0 ? relayWorkspaceId : null,
  };
}

export async function normalizeRelayWorkspaceIdToAppWorkspaceId(
  workspaceId: string,
): Promise<string | null> {
  const normalized = workspaceId.trim();
  if (!isRelayWorkspaceId(normalized)) return normalized;

  const resolved = await resolveAppWorkspaceByRelayWorkspaceId(normalized);
  return resolved.appWorkspaceId;
}
