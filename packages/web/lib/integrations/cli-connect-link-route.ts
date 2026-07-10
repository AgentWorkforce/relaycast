import { NextRequest, NextResponse } from "next/server";
import { buildPendingProviderMetadata } from "@cloud/core/provider-readiness.js";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  createConnectSession,
  getProviderConfigKey,
} from "@/lib/integrations/nango-service";
import {
  type WorkspaceIntegrationProvider,
  getWorkspaceIntegrationProviderDefinition,
  resolveWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { insertWorkspaceIntegrationIfAbsent } from "@/lib/integrations/workspace-integrations";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type CliConnectLinkBody = {
  integration?: string;
  provider?: string;
  workspaceId?: string;
  workspace?: {
    workspaceId?: string;
  };
};

type ConnectSessionWithOptionalSnakeConnectionId = Awaited<
  ReturnType<typeof createConnectSession>
> & {
  connection_id?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBodyString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBody(value: unknown): CliConnectLinkBody | null {
  if (!isObject(value)) {
    return null;
  }

  const workspace = isObject(value.workspace)
    ? {
        workspaceId: readBodyString(value.workspace, "workspaceId"),
      }
    : undefined;

  return {
    integration: readBodyString(value, "integration"),
    provider: readBodyString(value, "provider"),
    workspaceId: readBodyString(value, "workspaceId"),
    ...(workspace ? { workspace } : {}),
  };
}

function resolveWorkspaceId(body: CliConnectLinkBody): string | null {
  return body.workspaceId ?? body.workspace?.workspaceId ?? null;
}

function resolveProvider(
  value: string | undefined,
): WorkspaceIntegrationProvider | null {
  return resolveWorkspaceIntegrationProvider(value);
}

function readSessionConnectionId(
  session: ConnectSessionWithOptionalSnakeConnectionId,
): string | null {
  const connectionId =
    session.connectionId ??
    (typeof session.connection_id === "string" ? session.connection_id : null);
  return connectionId?.trim() || null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const workspaceId = resolveWorkspaceId(body);
  if (!workspaceId) {
    return NextResponse.json(
      { error: "workspaceId is required" },
      { status: 400 },
    );
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const integrationWorkspaceId = identity.relayWorkspaceId;

  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const provider = resolveProvider(body.provider ?? body.integration);
  if (!provider) {
    return NextResponse.json(
      {
        error:
          "provider or integration must be one of: slack, github, notion, linear",
      },
      { status: 400 },
    );
  }

  const providerConfigKey = getProviderConfigKey(provider);
  const providerDefinition =
    getWorkspaceIntegrationProviderDefinition(provider);
  const backend = "nango";
  const backendIntegrationId = providerConfigKey;
  const session = await createConnectSession({
    endUserId: integrationWorkspaceId,
    endUserEmail: auth.source === "session" ? auth.context?.user.email : null,
    allowedIntegrations: [providerConfigKey],
  });

  const connectUrl = session.connectLink;
  const connectionId = readSessionConnectionId(session);

  // Write the workspace_integrations row eagerly only when Nango returns the
  // real connection id. A workspaceId fallback corrupts the lookup key used by
  // later sync/forward webhooks; when no id is available yet, the auth webhook
  // and sync self-heal paths recover from Nango connection metadata instead.
  //
  // IMPORTANT: this is an atomic INSERT ... ON CONFLICT DO NOTHING keyed on
  // (workspaceId, provider). A read-then-upsert leaves a window where the
  // auth webhook can write the real row between the existence check and the
  // upsert, after which the upsert's conflict-update path clobbers the live
  // connectionId/installationId/readiness blob with the placeholder values.
  // Pushing the insert-if-absent decision down to the database closes that
  // race. If a row already exists for this (workspaceId, provider), do
  // nothing — the auth webhook (or a prior connect-link) owns the real
  // values; we never upgrade an existing row from this path.
  if (connectionId) {
    try {
      await insertWorkspaceIntegrationIfAbsent({
        workspaceId: integrationWorkspaceId,
        provider,
        connectionId,
        providerConfigKey,
        installationId: null,
        // Seed explicit pending readiness so status routes don't treat the
        // empty-metadata placeholder as a legacy "connected" row and prematurely
        // report initialSync=complete / ready=true before OAuth completes.
        metadata: buildPendingProviderMetadata({
          connectionId,
          providerConfigKey,
        }),
      });
    } catch (error) {
      // Don't fail the connect-link request if the placeholder insert cannot be
      // written; the auth webhook + handleSyncEvent self-heal still cover this
      // case.
      console.warn(
        `[integrations] Failed to pre-create workspace_integrations row for ${provider}/${integrationWorkspaceId}:`,
        error,
      );
    }
  }

  return NextResponse.json({
    provider,
    backend,
    backendIntegrationId,
    providerConfigKey,
    workspaceId,
    relayWorkspaceId: integrationWorkspaceId,
    token: session.token,
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    ...(connectionId ? { connectionId } : {}),
    connectUrl,
    connectLink: connectUrl,
    url: connectUrl,
    providers: [
      {
        id: provider,
        displayName: providerDefinition.displayName,
        backend,
        backendIntegrationId,
        providerConfigKey,
        backendMetadata: {},
        vfsRoot: providerDefinition.vfsRoot,
      },
    ],
  });
}
