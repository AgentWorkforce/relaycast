import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  adoptIntegrationConnection,
  type AdoptIntegrationResult,
} from "@/lib/integrations/adopt-integration";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
} from "@/lib/integrations/integration-route-handler";
import { resolveWorkspaceIntegrationProvider } from "@/lib/integrations/providers";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type AdoptRouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type AdoptRequestBody = {
  connectionId?: unknown;
  providerConfigKey?: unknown;
};

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function statusForResult(result: AdoptIntegrationResult): number {
  if (result.ok) {
    return 200;
  }
  switch (result.code) {
    case "connection_not_found":
      return 404;
    case "workspace_mismatch":
    case "existing_connection_live_or_unknown":
      return 409;
    default: {
      const unreachable: never = result.code;
      throw new Error(`Unhandled adopt failure code: ${unreachable}`);
    }
  }
}

export async function POST(request: NextRequest, context: AdoptRouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;
  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);

  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Adopt only targets the static workspace_integrations providers (nango-
  // backed: slack, github, notion, linear). Composio toolkits go through
  // their own connect flow and don't need an out-of-band adopt path today.
  const resolvedProvider = resolveWorkspaceIntegrationProvider(provider);
  if (!resolvedProvider) {
    return NextResponse.json(
      { error: "Integration provider not found", code: "unknown_provider" },
      { status: 404 },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body: AdoptRequestBody =
    rawBody && typeof rawBody === "object" ? (rawBody as AdoptRequestBody) : {};
  const connectionId = readNonEmptyString(body.connectionId);
  if (!connectionId) {
    return NextResponse.json(
      { error: "connectionId is required" },
      { status: 400 },
    );
  }
  const providerConfigKey = readNonEmptyString(body.providerConfigKey);

  try {
    const result = await adoptIntegrationConnection({
      workspaceId: identity.relayWorkspaceId,
      provider: resolvedProvider,
      connectionId,
      providerConfigKey,
    });

    if (result.ok) {
      return NextResponse.json(
        result.replacedConnectionId
          ? {
              ok: true,
              connectionId: result.connectionId,
              replacedConnectionId: result.replacedConnectionId,
              workspaceId: identity.requestedWorkspaceId,
              relayWorkspaceId: identity.relayWorkspaceId,
            }
          : {
              ok: true,
              connectionId: result.connectionId,
              workspaceId: identity.requestedWorkspaceId,
              relayWorkspaceId: identity.relayWorkspaceId,
            },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        error: result.message,
        ...(result.pathWorkspaceId
          ? { pathWorkspaceId: result.pathWorkspaceId }
          : {}),
        ...(result.connectionWorkspaceId
          ? { connectionWorkspaceId: result.connectionWorkspaceId }
          : {}),
        ...(result.existingConnectionId
          ? { existingConnectionId: result.existingConnectionId }
          : {}),
        ...(result.existingLiveness
          ? { existingLiveness: result.existingLiveness }
          : {}),
        workspaceId: identity.requestedWorkspaceId,
        relayWorkspaceId: identity.relayWorkspaceId,
      },
      { status: statusForResult(result) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Drizzle wraps the underlying pg error; the actionable Postgres detail
    // (constraint name, SQLSTATE) lives on error.cause. Surface it so 500s are
    // diagnosable from the response instead of only the query-failed wrapper.
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : undefined;
    console.error("Integration adopt failed:", error);
    return NextResponse.json(
      {
        error: "Failed to adopt integration connection",
        detail: message,
        ...(cause ? { cause } : {}),
      },
      { status: 500 },
    );
  }
}
