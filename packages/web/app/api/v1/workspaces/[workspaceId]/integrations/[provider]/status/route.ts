import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import {
  buildLegacyConnectedReadiness,
  readProviderReadiness,
  type ProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  BackendPolicyError,
  getIntegrationBackend,
  selectIntegrationBackend,
  type BackendConnection,
} from "@/lib/integrations/backend";
import { BackendNotConfiguredError } from "@/lib/integrations/backend-config";
import { resolveComposioToolkit } from "@/lib/integrations/composio-service";
import {
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
  resolveWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { disconnectIntegrationBackend } from "@/lib/integrations/disconnect-integration-backend";
import {
  readIntegrationConnectionScopeFromSearchParams,
  type IntegrationConnectionScope,
} from "@/lib/integrations/integration-scope";
import {
  CLOUD_INTEGRATIONS_WRITE_SCOPE,
  hasCloudControlScope,
} from "@/lib/integrations/integration-route-handler";
import {
  deriveProviderState,
  fetchWorkspaceProviderSyncStatus,
  liveNangoInitialSyncSucceeded,
  summarizeWritebackHealth,
  summarizeProviderInitialSync,
  type ProviderState,
} from "@/lib/integrations/provider-status";
import { getUserIntegration } from "@/lib/integrations/user-integrations";
import type { UserIntegrationRecord } from "@/lib/integrations/user-integrations";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { createCredentialStoreS3Client } from "@/lib/storage";
import {
  getNangoSyncScheduleStatuses,
  type NangoSyncScheduleStatus,
} from "@/lib/integrations/nango-service";
import { warnIfStalePendingSync } from "@/lib/integrations/nango-sync-subscription-recovery";
import {
  getWorkspaceIntegration,
  getWorkspaceIntegrationByName,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import {
  hasWorkspaceIntegrationAccess,
  hasWorkspaceIntegrationReadAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type IntegrationStatusLookup =
  | WorkspaceIntegrationRecord
  | UserIntegrationRecord
  | null;

type ResolvedStatusProvider = {
  provider: string;
  integration: IntegrationStatusLookup;
  dynamicDisplayName?: string;
  dynamicToolkitSlug?: string;
};

type IntegrationStatusRouteContext = {
  params: Promise<{ workspaceId: string; provider: string }>;
};

type IntegrationStatusResponse = {
  ready: boolean;
  state: ProviderState;
  provider: string;
  displayName: string;
  backend?: string;
  backendIntegrationId?: string;
  configKey: string;
  vfsRoot: string;
  requestedConnectionId: string | null;
  currentConnectionId: string | null;
  connectionMatched: boolean;
  webhookHealthy: boolean | null;
  webhookHealth: ReturnType<typeof summarizeWritebackHealth>["webhookHealth"];
  oauth: {
    connected: boolean;
    connectedAt: string | null;
    lastAuthAt: string | null;
  };
  initialSync: ProviderReadiness["initialSync"];
  // True when the productized `state`/`ready` were promoted from the live Nango
  // sync schedule (all syncs SUCCESS) because the PERSISTED readiness blob was
  // still not `complete`. Surfaces that the durable sync-completion pipeline
  // (sync webhook -> nango_sync job -> markProviderInitialSyncComplete) lagged
  // or failed for this row, so the promotion is never a silent mask.
  readinessStale: boolean;
  writeback: ReturnType<typeof summarizeWritebackHealth>;
  nangoSyncSchedules: {
    ok: boolean;
    status?: number;
    error?: string | null;
    syncs: NangoSyncScheduleStatus[];
  } | null;
};

type ErrorResponse = {
  error: string;
  code?: string;
  backend?: string;
};

const DAYTONA_PROVIDER = "daytona";

function resolveReadiness(
  integration: IntegrationStatusLookup,
): ProviderReadiness {
  if (!integration) {
    return {
      oauthConnectedAt: null,
      lastAuthAt: null,
      connectionId: null,
      providerConfigKey: null,
      updatedAt: null,
      initialSync: {
        state: "unknown",
        enqueuedAt: null,
        startedAt: null,
        completedAt: null,
        failedAt: null,
        lastError: null,
        syncName: null,
        model: null,
        modifiedAfter: null,
        byModel: {},
      },
    };
  }

  return readProviderReadiness(integration.metadata) ??
    buildLegacyConnectedReadiness({
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
    });
}

function isBackendConnectionUsable(connection: BackendConnection): boolean {
  return connection.status === undefined || connection.status !== "inactive";
}

function backendPolicyStatus(error: BackendPolicyError): number {
  switch (error.code) {
    case "backend_not_configured":
    case "backend_not_implemented":
      return 501;
    case "backend_misconfigured":
    case "backend_not_allowed":
      return 400;
    default: {
      const unreachableCode: never = error.code;
      throw new Error(`Unhandled backend policy error code: ${unreachableCode}`);
    }
  }
}

function backendPolicyResponse(error: BackendPolicyError): Response {
  return NextResponse.json<ErrorResponse>(
    {
      error: error.message,
      code: error.code,
      backend: error.backend,
    },
    { status: backendPolicyStatus(error) },
  );
}

async function resolveStatusProvider(
  workspaceId: string,
  userId: string,
  provider: string,
  scope: IntegrationConnectionScope,
): Promise<ResolvedStatusProvider | null> {
  const staticProvider = resolveWorkspaceIntegrationProvider(provider);
  if (staticProvider) {
    if (scope.kind === "deployer_user") {
      return {
        provider: staticProvider,
        integration: await getUserIntegration(userId, staticProvider),
      };
    }

    return {
      provider: staticProvider,
      integration: scope.kind === "workspace_service_account"
        ? await getWorkspaceIntegrationByName(workspaceId, staticProvider, scope.name)
        : await getWorkspaceIntegration(workspaceId, staticProvider),
    };
  }

  const candidate = provider.trim().toLowerCase();
  if (!candidate) {
    return null;
  }

  const existingIntegration = await getWorkspaceIntegration(
    workspaceId,
    candidate,
  );
  if (existingIntegration) {
    return {
      provider: candidate,
      integration: existingIntegration,
    };
  }

  try {
    const toolkit = await resolveComposioToolkit(candidate);
    const toolkitSlug = typeof toolkit?.slug === "string"
      ? toolkit.slug.trim()
      : "";
    if (!toolkitSlug) {
      return null;
    }

    return {
      provider: toolkitSlug,
      integration: await getWorkspaceIntegration(workspaceId, toolkitSlug),
      dynamicDisplayName:
        typeof toolkit?.name === "string" && toolkit.name.trim()
          ? toolkit.name.trim()
          : toolkitSlug,
      dynamicToolkitSlug: toolkitSlug,
    };
  } catch (error) {
    if (error instanceof BackendNotConfiguredError) {
      throw new BackendPolicyError(
        "backend_not_configured",
        "Composio backend not configured",
        "composio",
      );
    }
    throw error;
  }
}

function unknownProviderResponse(): Response {
  return NextResponse.json<ErrorResponse>(
    {
      error: "Integration provider not found",
      code: "unknown_provider",
    },
    { status: 404 },
  );
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function defaultInitialSync(): ProviderReadiness["initialSync"] {
  return {
    state: "complete",
    enqueuedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastError: null,
    syncName: null,
    model: null,
    modifiedAfter: null,
    byModel: {},
  };
}

function defaultWriteback(): ReturnType<typeof summarizeWritebackHealth> {
  return {
    state: "unknown",
    lagSeconds: null,
    watermarkTs: null,
    lastError: null,
    deadLetteredEnvelopes: 0,
    deadLetteredOps: 0,
    failureCodes: {},
    webhookHealthy: null,
    webhookHealth: {
      healthy: false,
      lastEventAt: null,
      lastError: "Daytona credentials are stored outside Relayfile sync",
    },
  };
}

async function daytonaCredentialStatusResponse(input: {
  userId: string;
  workspaceId: string;
}): Promise<Response> {
  const [row] = await getDb()
    .select({
      id: providerCredentials.id,
      status: providerCredentials.status,
      credentialStoredAt: providerCredentials.credentialStoredAt,
      credentialExpiresAt: providerCredentials.credentialExpiresAt,
      lastAuthenticatedAt: providerCredentials.lastAuthenticatedAt,
      updatedAt: providerCredentials.updatedAt,
    })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, input.userId),
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.modelProvider, DAYTONA_PROVIDER),
        eq(providerCredentials.authType, "provider_oauth"),
      ),
    )
    .orderBy(desc(providerCredentials.isActive), desc(providerCredentials.updatedAt))
    .limit(1);

  let stored = false;
  try {
    const s3 = await createCredentialStoreS3Client({ userId: input.userId });
    const store = new CredentialStore({
      bucket: Resource.WorkflowStorage.bucketName,
      prefix: "credentials",
      encryptionKey: Resource.CredentialEncryptionKey.value,
      client: s3,
    });
    stored = await store.exists(input.userId, DAYTONA_PROVIDER);
  } catch (error) {
    console.warn(
      "Daytona credential status store lookup failed:",
      error instanceof Error ? error.message : String(error),
    );
  }

  const connected = row?.status === "connected" && stored;
  const state: ProviderState = connected ? "ready" : "pending";
  const initialSync = defaultInitialSync();
  const writeback = defaultWriteback();

  return NextResponse.json<IntegrationStatusResponse>({
    ready: connected,
    state,
    provider: DAYTONA_PROVIDER,
    displayName: "Daytona",
    backend: "provider-credential",
    backendIntegrationId: DAYTONA_PROVIDER,
    configKey: DAYTONA_PROVIDER,
    vfsRoot: "/daytona",
    requestedConnectionId: null,
    currentConnectionId: row?.id ?? null,
    connectionMatched: true,
    webhookHealthy: writeback.webhookHealthy,
    webhookHealth: writeback.webhookHealth,
    oauth: {
      connected,
      connectedAt: toIso(row?.credentialStoredAt),
      lastAuthAt: toIso(row?.lastAuthenticatedAt),
    },
    initialSync,
    readinessStale: false,
    writeback,
    nangoSyncSchedules: null,
  });
}

export async function GET(
  request: NextRequest,
  context: IntegrationStatusRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const integrationWorkspaceId = identity.relayWorkspaceId;

  if (!hasWorkspaceIntegrationReadAccess(auth, identity)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }
  try {
    const scope = readIntegrationConnectionScopeFromSearchParams(request.nextUrl.searchParams);
    if (!scope) {
      return NextResponse.json<ErrorResponse>(
        { error: "Invalid integration scope", code: "invalid_scope" },
        { status: 400 },
      );
    }
    if (provider.trim().toLowerCase() === DAYTONA_PROVIDER) {
      return daytonaCredentialStatusResponse({
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      });
    }
    const resolved = await resolveStatusProvider(
      integrationWorkspaceId,
      auth.userId,
      provider,
      scope,
    );
    if (!resolved) {
      return unknownProviderResponse();
    }

    const { provider: resolvedProvider, integration } = resolved;
    const backendSelection = isWorkspaceIntegrationProvider(resolvedProvider)
      ? selectIntegrationBackend({
        workspaceId: integrationWorkspaceId,
        provider: resolvedProvider,
      })
      : {
        backend: "composio" as const,
        backendIntegrationId:
          resolved.dynamicToolkitSlug ??
          integration?.providerConfigKey?.replace(/-composio-relay$/, "") ??
          resolvedProvider,
      };
    const backend = await getIntegrationBackend(backendSelection.backend);
    const connection = integration
      ? await backend.getConnection({
          connectionId: integration.connectionId,
          backendIntegrationId:
            integration.providerConfigKey ?? backendSelection.backendIntegrationId,
          provider: resolvedProvider,
        })
      : null;
    const requestedConnectionId =
      request.nextUrl.searchParams.get("connectionId")?.trim() ?? "";
    const usesWorkspacePollingKey =
      !requestedConnectionId ||
      requestedConnectionId === workspaceId ||
      requestedConnectionId === integrationWorkspaceId;
    const storedConnectionMatched = usesWorkspacePollingKey
      ? integration !== null
      : integration?.connectionId === requestedConnectionId;
    const connectionMatched = connection
      ? storedConnectionMatched && isBackendConnectionUsable(connection)
      : storedConnectionMatched;
    const readiness = resolveReadiness(integration);
    const providerDefinition = isWorkspaceIntegrationProvider(resolvedProvider)
      ? getWorkspaceIntegrationProviderDefinition(resolvedProvider)
      : {
        displayName: resolved.dynamicDisplayName ?? resolvedProvider,
        vfsRoot: `/${resolvedProvider}`,
      };
    const expectedProviderConfigKey = isWorkspaceIntegrationProvider(resolvedProvider)
      ? getWorkspaceIntegrationProviderDefinition(resolvedProvider).defaultConfigKey
      : integration?.providerConfigKey ?? readiness.providerConfigKey;
    const relayfileStatus = await fetchWorkspaceProviderSyncStatus(
      integrationWorkspaceId,
      resolvedProvider,
    ).catch(() => null);
    const writeback = summarizeWritebackHealth(relayfileStatus);
    const initialSync = summarizeProviderInitialSync({
      readiness,
      providerConfigKey: expectedProviderConfigKey,
    });
    const state = deriveProviderState({
      initialSync,
      writeback,
    });
    warnIfStalePendingSync({
      workspaceId: integrationWorkspaceId,
      provider: resolvedProvider,
      connectionId: integration?.connectionId ?? readiness.connectionId,
      providerConfigKey:
        integration?.providerConfigKey ??
        readiness.providerConfigKey ??
        expectedProviderConfigKey,
      source: "status-poll",
      state,
      readiness,
      initialSync,
      writeback,
    });
    const nangoSyncSchedules =
      integration && backendSelection.backend === "nango"
        ? await getNangoSyncScheduleStatuses({
            providerConfigKey:
              integration.providerConfigKey ?? backendSelection.backendIntegrationId,
            connectionId: integration.connectionId,
          }).catch((error) => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            syncs: [],
          }))
        : null;

    // Resilience: the persisted readiness blob only reaches `complete` when the
    // durable sync-completion pipeline runs (Nango sync webhook -> nango_sync
    // job -> markProviderInitialSyncComplete). If that pipeline is degraded the
    // blob can stay non-complete forever even though Nango has finished every
    // sync. When the live Nango schedule reports all syncs SUCCESS, the upstream
    // data is present, so re-derive the productized state as if the initial sync
    // completed — keeping writeback health in the picture via deriveProviderState
    // rather than blindly forcing "ready". `readinessStale` records the
    // promotion so a broken persisted pipeline stays observable.
    const readinessStale =
      liveNangoInitialSyncSucceeded(nangoSyncSchedules) &&
      initialSync.state !== "complete";
    const effectiveState = readinessStale
      ? deriveProviderState({
          initialSync: { ...initialSync, state: "complete" },
          writeback,
        })
      : state;

    return NextResponse.json<IntegrationStatusResponse>({
      ready: Boolean(integration) && connectionMatched && effectiveState === "ready",
      state: effectiveState,
      provider: resolvedProvider,
      displayName: providerDefinition.displayName,
      backend: backendSelection.backend,
      backendIntegrationId: backendSelection.backendIntegrationId,
      configKey:
        integration?.providerConfigKey ??
        readiness.providerConfigKey ??
        backendSelection.backendIntegrationId,
      vfsRoot: providerDefinition.vfsRoot,
      requestedConnectionId: requestedConnectionId || null,
      currentConnectionId: integration?.connectionId ?? readiness.connectionId,
      connectionMatched,
      webhookHealthy: writeback.webhookHealthy,
      webhookHealth: writeback.webhookHealth,
      oauth: {
        connected: integration !== null,
        connectedAt: readiness.oauthConnectedAt,
        lastAuthAt: readiness.lastAuthAt,
      },
      initialSync,
      readinessStale,
      writeback,
      nangoSyncSchedules,
    });
  } catch (error) {
    if (error instanceof BackendPolicyError) {
      return backendPolicyResponse(error);
    }

    console.error("Integration status lookup failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to check integration status" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: IntegrationStatusRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, provider } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  const integrationWorkspaceId = identity.relayWorkspaceId;

  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }
  if (!hasCloudControlScope(auth, CLOUD_INTEGRATIONS_WRITE_SCOPE)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  try {
    const resolved = await resolveStatusProvider(
      integrationWorkspaceId,
      auth.userId,
      provider,
      { kind: "workspace" },
    );
    if (!resolved) {
      return unknownProviderResponse();
    }

    await disconnectIntegrationBackend({
      workspaceId: integrationWorkspaceId,
      provider: resolved.provider,
      integration:
        resolved.integration && "workspaceId" in resolved.integration
          ? resolved.integration
          : null,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof BackendPolicyError) {
      return backendPolicyResponse(error);
    }

    console.error("Integration disconnect failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to disconnect integration" },
      { status: 500 },
    );
  }
}
