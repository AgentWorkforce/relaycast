import { NextRequest, NextResponse } from "next/server";
import {
  buildLegacyConnectedReadiness,
  readProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { hasWorkspaceReadAccess } from "@/lib/integrations/integration-route-handler";
import {
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  deriveProviderState,
  fetchWorkspaceProviderSyncStatus,
  summarizeProviderInitialSync,
  summarizeWritebackHealth,
  type ProviderState,
} from "@/lib/integrations/provider-status";
import {
  listWorkspaceIntegrations,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { warnIfStalePendingSync } from "@/lib/integrations/nango-sync-subscription-recovery";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ProviderSyncEntry = {
  provider: string;
  status: ProviderState;
  lagSeconds: number;
  watermarkTs: string | null;
  lastError: string | null;
  failureCodes: Record<string, number>;
  deadLetteredEnvelopes: number;
  deadLetteredOps: number;
  webhookHealthy: boolean | null;
  webhookHealth: ReturnType<typeof summarizeWritebackHealth>["webhookHealth"];
};

type SyncResponse = {
  workspaceId: string;
  providers: ProviderSyncEntry[];
};

type ErrorResponse = { error: string };

async function buildEntry(
  integration: WorkspaceIntegrationRecord,
): Promise<ProviderSyncEntry | null> {
  if (!isWorkspaceIntegrationProvider(integration.provider)) {
    return null;
  }

  const readiness =
    readProviderReadiness(integration.metadata) ??
    buildLegacyConnectedReadiness({
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
    });
  const upstream = await fetchWorkspaceProviderSyncStatus(
    integration.workspaceId,
    integration.provider,
  ).catch(() => null);
  const writeback = summarizeWritebackHealth(upstream);
  const definition = getWorkspaceIntegrationProviderDefinition(integration.provider);
  const initialSync = summarizeProviderInitialSync({
    readiness,
    providerConfigKey:
      definition.defaultConfigKey ??
      integration.providerConfigKey ??
      readiness.providerConfigKey,
  });
  const status = deriveProviderState({
    initialSync,
    writeback,
  });
  warnIfStalePendingSync({
    workspaceId: integration.workspaceId,
    provider: integration.provider,
    connectionId: integration.connectionId,
    providerConfigKey: integration.providerConfigKey,
    source: "status-poll",
    state: status,
    readiness,
    initialSync,
    writeback,
  });

  return {
    provider: integration.provider,
    status,
    lagSeconds: writeback.lagSeconds ?? 0,
    watermarkTs: writeback.watermarkTs,
    lastError: writeback.lastError ?? initialSync.lastError,
    failureCodes: writeback.failureCodes,
    deadLetteredEnvelopes: writeback.deadLetteredEnvelopes,
    deadLetteredOps: writeback.deadLetteredOps,
    webhookHealthy: writeback.webhookHealthy,
    webhookHealth: writeback.webhookHealth,
  };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasWorkspaceReadAccess(auth, workspaceId)) {
    return NextResponse.json<ErrorResponse>({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const integrations = await listWorkspaceIntegrations(workspaceId);
    const entries = await Promise.all(integrations.map(buildEntry));
    const providers = entries.filter(
      (entry): entry is ProviderSyncEntry => entry !== null,
    );
    return NextResponse.json<SyncResponse>({ workspaceId, providers });
  } catch (error) {
    console.error("Workspace sync aggregate failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to read sync status" },
      { status: 500 },
    );
  }
}
