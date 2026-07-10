import {
  buildLegacyConnectedReadiness,
  readProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import {
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  deriveProviderState,
  fetchWorkspaceProviderSyncStatus,
  summarizeWritebackHealth,
  summarizeProviderInitialSync,
} from "@/lib/integrations/provider-status";
import { warnIfStalePendingSync } from "@/lib/integrations/nango-sync-subscription-recovery";

export type IntegrationListRecord = {
  workspaceId?: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
  installationId?: string | null;
  metadata: Record<string, unknown>;
};

export type IntegrationListEntry = {
  provider: string;
  providerConfigKey: string | null;
  status: string;
  lagSeconds?: number;
  lastEventAt?: string;
  connectionId?: string;
  installationId?: string;
  webhookHealthy?: boolean;
  webhookHealth?: ReturnType<typeof summarizeWritebackHealth>["webhookHealth"];
  deprecated?: boolean;
};

export async function buildIntegrationListEntry(
  integration: IntegrationListRecord,
): Promise<IntegrationListEntry> {
  const readiness =
    readProviderReadiness(integration.metadata) ??
    buildLegacyConnectedReadiness({
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
    });
  const upstream = integration.workspaceId
    ? await fetchWorkspaceProviderSyncStatus(
        integration.workspaceId,
        integration.provider,
      ).catch(() => null)
    : null;
  const writeback = summarizeWritebackHealth(upstream);
  const definition = isWorkspaceIntegrationProvider(integration.provider)
    ? getWorkspaceIntegrationProviderDefinition(integration.provider)
    : null;
  const initialSync = summarizeProviderInitialSync({
    readiness,
    providerConfigKey:
      definition?.defaultConfigKey ??
      integration.providerConfigKey ??
      readiness.providerConfigKey,
  });
  const state = deriveProviderState({
    initialSync,
    writeback,
  });
  if (integration.workspaceId) {
    warnIfStalePendingSync({
      workspaceId: integration.workspaceId,
      provider: integration.provider,
      connectionId: integration.connectionId,
      providerConfigKey: integration.providerConfigKey,
      source: "integration-list",
      state,
      readiness,
      initialSync,
      writeback,
    });
  }

  const entry: IntegrationListEntry = {
    provider: integration.provider,
    providerConfigKey: integration.providerConfigKey,
    status: state,
    connectionId: integration.connectionId,
  };
  if (writeback.lagSeconds !== null) {
    entry.lagSeconds = writeback.lagSeconds;
  }
  const lastEventAt =
    writeback.watermarkTs ?? initialSync.completedAt ?? readiness.updatedAt;
  if (lastEventAt) {
    entry.lastEventAt = lastEventAt;
  }
  if (writeback.webhookHealthy !== null) {
    entry.webhookHealthy = writeback.webhookHealthy;
  }
  if (integration.installationId) {
    entry.installationId = integration.installationId;
  }
  entry.webhookHealth = writeback.webhookHealth;
  if (definition) {
    if (definition.deprecated) {
      entry.deprecated = true;
    }
  }
  return entry;
}
