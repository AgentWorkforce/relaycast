import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  getNangoConnectionDetails,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import { getSlackConnectionIdentity } from "@/lib/integrations/nango-slack";
import type { WorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import { disconnectIntegrationBackend } from "@/lib/integrations/disconnect-integration-backend";
import { mergeSlackConnectionIdentityMetadata } from "@/lib/integrations/slack-identity";
import {
  findSlackIntegrationByTeamId,
  getWorkspaceIntegration,
  looksLikeSlackTeamId,
  type WorkspaceIntegrationRecord,
  upsertWorkspaceIntegration,
} from "@/lib/integrations/workspace-integrations";
import { looksLikeWorkspaceId } from "@/lib/integrations/workspace-identifiers";

export type WorkspaceIntegrationRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export type WorkspaceIntegrationResponseBody = {
  workspaceId: string | null;
  connectionId: string | null;
  providerConfigKey: string | null;
  installationId: string | null;
};

export function toWorkspaceIntegrationResponseBody(
  integration: Pick<
    WorkspaceIntegrationRecord,
    "workspaceId" | "connectionId" | "providerConfigKey" | "installationId"
  >,
): WorkspaceIntegrationResponseBody {
  return {
    workspaceId: integration.workspaceId,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
    installationId: integration.installationId,
  };
}

export function hasWorkspaceAccess(
  auth: Awaited<ReturnType<typeof resolveRequestAuth>>,
  workspaceId: string,
) {
  if (!auth) {
    return false;
  }

  if (auth.source === "session") {
    return auth.context?.workspaces.some((workspace) => workspace.id === workspaceId) ?? false;
  }

  return auth.workspaceId === workspaceId;
}

// Service-source callers (e.g. the Sage Worker using SageCloudApiToken) are
// allowed to read integration connection metadata for any workspace. Writes
// and deletes still go through the strict hasWorkspaceAccess check.
export function hasWorkspaceReadAccess(
  auth: Awaited<ReturnType<typeof resolveRequestAuth>>,
  workspaceId: string,
) {
  if (auth?.source === "service") {
    return true;
  }
  return hasWorkspaceAccess(auth, workspaceId);
}

export const CLOUD_INTEGRATIONS_WRITE_SCOPE = "cloud:integrations:write";
export const CLOUD_OPS_REPLAY_SCOPE = "cloud:ops:replay";

export function hasCloudControlScope(
  auth: Awaited<ReturnType<typeof resolveRequestAuth>>,
  scope: string,
): boolean {
  if (!auth || auth.source === "relayfile") {
    return false;
  }

  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, scope) ||
    requireAuthScope(auth, "cli:auth")
  );
}

type UpsertBody = {
  connectionId?: string;
  providerConfigKey?: string | null;
};

function isUpsertBody(value: unknown): value is UpsertBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return (
    (body.connectionId === undefined || typeof body.connectionId === "string") &&
    (body.providerConfigKey === undefined ||
      body.providerConfigKey === null ||
      typeof body.providerConfigKey === "string")
  );
}

function defaultWritebackDispatchVia(
  provider: WorkspaceIntegrationProvider,
): "bridge" | "cf" {
  return provider === "telegram" ? "cf" : "bridge";
}

function readRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
}

function readString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function readWorkspaceIdFromConnectionMetadata(
  metadata: Record<string, unknown>,
): string | null {
  const endUser = readRecord(metadata, "endUser") ?? readRecord(metadata, "end_user");
  const endUserTags = readRecord(endUser, "tags");
  const payloadTags = readRecord(metadata, "tags");
  const candidates = [
    readString(endUser, "id"),
    readString(endUser, "endUserId"),
    readString(endUser, "end_user_id"),
    readString(metadata, "endUserId"),
    readString(metadata, "end_user_id"),
    readString(metadata, "workspaceId"),
    readString(metadata, "workspace_id"),
    readString(endUserTags, "end_user_id"),
    readString(endUserTags, "endUserId"),
    readString(endUserTags, "workspaceId"),
    readString(endUserTags, "workspace_id"),
    readString(payloadTags, "end_user_id"),
    readString(payloadTags, "endUserId"),
    readString(payloadTags, "workspaceId"),
    readString(payloadTags, "workspace_id"),
  ];

  return candidates.find((candidate) => Boolean(candidate)) ?? null;
}

async function resolveIntegrationMetadata(
  provider: WorkspaceIntegrationProvider,
  connectionId: string,
  providerConfigKey: string,
  baseMetadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!provider.startsWith("slack")) {
    return baseMetadata;
  }

  try {
    const identity = await getSlackConnectionIdentity(connectionId, providerConfigKey);
    return mergeSlackConnectionIdentityMetadata(baseMetadata, identity);
  } catch (error) {
    console.warn(
      `[integrations] Failed to enrich Slack integration metadata for ${provider}/${connectionId}:`,
      error,
    );
    return baseMetadata;
  }
}

/**
 * Resolve a path-level workspace identifier to a stored workspace id.
 *
 * Sage only has the Slack team id from webhook payloads, not the cloud
 * workspace id. When the path segment looks like a Slack team id (T... /
 * E...) we resolve it through `findSlackIntegrationByTeamId` — the same
 * lookup the Slack proxy uses — and return the canonical workspace id so
 * the rest of the handler can do a normal provider-scoped lookup.
 *
 * The returned id may be either a UUID or a `rw_<8hex>` value depending on
 * how the integration row was provisioned; both are valid keys against
 * `workspace_integrations`.
 */
export async function resolveWorkspaceUuid(
  raw: string,
): Promise<string | null> {
  const trimmed = raw.trim();
  if (looksLikeWorkspaceId(trimmed)) {
    return trimmed;
  }

  if (looksLikeSlackTeamId(trimmed)) {
    const slackIntegration = await findSlackIntegrationByTeamId(trimmed);
    return slackIntegration?.workspaceId ?? null;
  }

  return null;
}

export function createIntegrationRouteHandlers(
  provider: WorkspaceIntegrationProvider,
) {
  async function GET(request: NextRequest, context: WorkspaceIntegrationRouteContext) {
    const auth = await resolveRequestAuth(request);
    const { workspaceId: rawWorkspaceId } = await context.params;
    const emptyBody: WorkspaceIntegrationResponseBody = {
      workspaceId: null,
      connectionId: null,
      providerConfigKey: null,
      installationId: null,
    };

    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = await resolveWorkspaceUuid(rawWorkspaceId);
    if (!workspaceId) {
      return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });
    }
    if (!hasWorkspaceReadAccess(auth, workspaceId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const integration = await getWorkspaceIntegration(workspaceId, provider);
    return NextResponse.json(
      integration ? toWorkspaceIntegrationResponseBody(integration) : emptyBody,
    );
  }

  async function POST(request: NextRequest, context: WorkspaceIntegrationRouteContext) {
    const auth = await resolveRequestAuth(request);
    const { workspaceId: rawWorkspaceId } = await context.params;

    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = await resolveWorkspaceUuid(rawWorkspaceId);
    if (!workspaceId) {
      return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });
    }

    if (!hasWorkspaceAccess(auth, workspaceId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (!isUpsertBody(body) || !body.connectionId?.trim()) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
    }

    const connectionId = body.connectionId.trim();
    const providerConfigKey = body.providerConfigKey?.trim() || getProviderConfigKey(provider);
    const details = await getNangoConnectionDetails(connectionId, providerConfigKey);
    if (!details?.payload) {
      return NextResponse.json(
        { error: "connection_not_found" },
        { status: 404 },
      );
    }
    const connectionWorkspaceId = readWorkspaceIdFromConnectionMetadata(details.payload);
    if (!connectionWorkspaceId || connectionWorkspaceId !== workspaceId) {
      return NextResponse.json(
        {
          error: "workspace_mismatch",
          workspaceId,
          ...(connectionWorkspaceId ? { connectionWorkspaceId } : {}),
        },
        { status: 409 },
      );
    }
    const metadata = await resolveIntegrationMetadata(
      provider,
      connectionId,
      providerConfigKey,
      details.payload,
    );
    const integration = await upsertWorkspaceIntegration({
      workspaceId,
      provider,
      connectionId,
      providerConfigKey,
      installationId: details?.installationId ?? null,
      metadata,
      writebackDispatchVia: defaultWritebackDispatchVia(provider),
    });

    return NextResponse.json(integration, { status: 201 });
  }

  async function DELETE(request: NextRequest, context: WorkspaceIntegrationRouteContext) {
    const auth = await resolveRequestAuth(request);
    const { workspaceId: rawWorkspaceId } = await context.params;

    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workspaceId = await resolveWorkspaceUuid(rawWorkspaceId);
    if (!workspaceId) {
      return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });
    }

    if (!hasWorkspaceAccess(auth, workspaceId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const integration = await getWorkspaceIntegration(workspaceId, provider);
    const result = await disconnectIntegrationBackend({ workspaceId, provider, integration });

    return NextResponse.json({ success: true, ...result });
  }

  return { GET, POST, DELETE };
}
