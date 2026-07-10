/**
 * Resolve the relay workspace for a workflow run — or provision + bind one
 * automatically on first use.
 *
 * Background: the `workspaces` table uses UUID primary keys, but relay
 * workspaces use `rw_xxxxxxxx` IDs and live in the separate
 * `relay_workspaces` table. Previously there was no stored binding between
 * the two, so the run route silently generated a fresh `rw_` ID every call
 * when `auth.workspaceId` wasn't `rw_`-format. That orphan ID never had a
 * DB row or a minted API key, the launcher dropped the empty `RELAY_API_KEY`
 * from the sandbox env, and the broker rejected with
 * "--register requires an API key (pass --api-key or set RELAY_API_KEY)".
 *
 * PR #242 closed the empty-key hole with a user-scoped fallback: reuse
 * the user's first existing relay workspace. That was correct for MVP but
 * meant all of a user's app workspaces shared one relay workspace. This
 * resolver uses the explicit `workspaces.relay_workspace_id` binding instead:
 *
 *   1. If auth.workspaceId is already `rw_`-format (legacy/bootstrap case)
 *      and has a DB row with a minted API key, repair that key against the
 *      configured Relaycast backend before use.
 *   2. Look up the app workspace row. If it has `relay_workspace_id` set
 *      AND that relay workspace has a minted key, repair that key against the
 *      configured Relaycast backend before use.
 *   3. Otherwise provision a fresh relay workspace via the registry (mints
 *      a relaycast API key, inserts the DB row) and bind it to the app
 *      workspace by updating `workspaces.relay_workspace_id`.
 *
 * If provisioning fails, throw — the caller should 500 rather than spawn a
 * doomed sandbox.
 *
 * Race safety: two concurrent runs for the same app workspace could both
 * observe an empty binding and both provision. The loser's `UPDATE ... SET
 * relay_workspace_id` is a lost write but not a corruption — the winner's
 * binding survives and subsequent runs are stable. Accept the small orphan
 * cost for now.
 */
import { eq } from "drizzle-orm";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import {
  createCloudWorkspaceRegistry,
  resolveRelaycastUrl,
} from "@/lib/workspace-registry";
import {
  getRelayWorkspace,
  isValidWorkspaceId,
} from "@/lib/relay-workspaces";
import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";

export type ResolvedRelayWorkspace = {
  id: string;
  relaycastApiKey: string;
  provisioned: boolean;
};

export async function resolveOrProvisionRelayWorkspace(input: {
  userId: string;
  appWorkspaceId: string;
  name?: string;
  forceProvision?: boolean;
}): Promise<ResolvedRelayWorkspace> {
  const { userId, appWorkspaceId } = input;

  if (!input.forceProvision && isValidWorkspaceId(appWorkspaceId)) {
    const record = await getRelayWorkspace(appWorkspaceId);
    if (record && record.relaycastApiKey.trim().length > 0) {
      return ensureRelaycastApiKeyForRelayWorkspace({
        relayWorkspaceId: record.id,
      });
    }
  }

  const boundRelayWorkspaceId = input.forceProvision
    ? null
    : await loadBoundRelayWorkspaceId(appWorkspaceId);
  if (boundRelayWorkspaceId) {
    const record = await getRelayWorkspace(boundRelayWorkspaceId);
    if (record && record.relaycastApiKey.trim().length > 0) {
      return ensureRelaycastApiKeyForRelayWorkspace({
        relayWorkspaceId: record.id,
      });
    }
  }

  const { registry } = createCloudWorkspaceRegistry();
  const entry = await registry.create({
    createdBy: userId,
    name: input.name?.trim() || "default",
  });

  const apiKey = entry.relaycastApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      `Workspace registry provisioned ${entry.id} but returned no relaycastApiKey — ` +
        `the relaycast backend did not mint a key. Check RELAYCAST_URL and service credentials.`,
    );
  }

  await bindRelayWorkspaceToAppWorkspace(appWorkspaceId, entry.id);

  return {
    id: entry.id,
    relaycastApiKey: apiKey,
    provisioned: true,
  };
}

type EnsureRelaycastKeyResponse = {
  ok?: boolean;
  data?: {
    workspace_id?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function relaycastInternalSecret(): string {
  const secret = tryResourceValue("RelaycastInternalSecret")
    ?? optionalEnv("RELAYCAST_INTERNAL_SECRET")
    ?? "";
  const trimmed = secret.trim();
  if (!trimmed || trimmed === "unset") {
    throw new Error("Relaycast internal secret is not configured");
  }
  return trimmed;
}

export async function ensureRelaycastApiKeyForRelayWorkspace(input: {
  relayWorkspaceId: string;
}): Promise<ResolvedRelayWorkspace> {
  const relayWorkspaceId = input.relayWorkspaceId.trim();
  if (!isValidWorkspaceId(relayWorkspaceId)) {
    throw new Error(`Invalid relay workspace id: ${input.relayWorkspaceId}`);
  }

  const existing = await getRelayWorkspace(relayWorkspaceId);
  if (!existing) {
    throw new Error(`Relay workspace ${relayWorkspaceId} is not registered`);
  }
  const apiKey = existing.relaycastApiKey.trim();
  if (!apiKey) {
    throw new Error(`Relay workspace ${relayWorkspaceId} has no relaycast API key to re-register`);
  }

  // Cloud has no explicit Relaycast workspace-key revocation tombstone today.
  // This repair is intentionally limited to an existing Cloud registry row with
  // a stored key; an explicit revoke flow should add a tombstone before calling
  // this helper from broader recovery paths.
  const response = await globalThis.fetch(
    `${trimTrailingSlash(resolveRelaycastUrl())}/internal/workspaces/${encodeURIComponent(relayWorkspaceId)}/api-key`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${relaycastInternalSecret()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ api_key: apiKey }),
    },
  );
  const payload = (await response.json().catch(() => null)) as EnsureRelaycastKeyResponse | null;
  if (!response.ok || payload?.data?.workspace_id !== relayWorkspaceId) {
    const message = payload?.error?.message || response.statusText || "unknown";
    throw new Error(`Relaycast workspace key repair failed: ${response.status} ${message}`);
  }

  return {
    id: existing.id,
    relaycastApiKey: apiKey,
    provisioned: false,
  };
}

async function loadBoundRelayWorkspaceId(appWorkspaceId: string): Promise<string | null> {
  // Only app workspace IDs in the `workspaces` table have a binding column.
  // If appWorkspaceId isn't a valid UUID (e.g. service auth with workspaceId=""),
  // skip the lookup rather than pushing a malformed query at Postgres.
  if (!appWorkspaceId || !isUuid(appWorkspaceId)) return null;

  const db = getDb();
  const [row] = await db
    .select({ relayWorkspaceId: workspaces.relayWorkspaceId })
    .from(workspaces)
    .where(eq(workspaces.id, appWorkspaceId))
    .limit(1);

  const value = row?.relayWorkspaceId?.trim() ?? "";
  return value.length > 0 ? value : null;
}

async function bindRelayWorkspaceToAppWorkspace(
  appWorkspaceId: string,
  relayWorkspaceId: string,
): Promise<void> {
  if (!appWorkspaceId || !isUuid(appWorkspaceId)) return;

  const db = getDb();
  await db
    .update(workspaces)
    .set({ relayWorkspaceId, updatedAt: new Date() })
    .where(eq(workspaces.id, appWorkspaceId));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
