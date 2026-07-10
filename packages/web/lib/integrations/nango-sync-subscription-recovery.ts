import {
  buildLegacyConnectedReadiness,
  readProviderReadiness,
  type ProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import {
  getWorkspaceIntegrationProviderDefinition,
  isWorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import { logger } from "@/lib/logger";
import {
  deriveProviderState,
  fetchWorkspaceProviderSyncStatus,
  summarizeProviderInitialSync,
  summarizeWritebackHealth,
  type ProviderState,
  type WritebackHealth,
} from "@/lib/integrations/provider-status";
import type { WorkspaceIntegrationRecord } from "@/lib/integrations/workspace-integrations";
import {
  getEnabledNangoSyncNamesForProviderConfigKey,
  getNangoConnection,
  getNangoSyncScheduleStatuses,
  pauseNangoSyncSchedules,
  startNangoSyncSchedules,
  triggerNangoSyncs,
} from "./nango-service";

export const STALE_PENDING_SYNC_THRESHOLD_MS = 60 * 60 * 1000;
const SLACK_DISCOVERY_SYNC_NAMES = ["fetch-users", "fetch-channels"] as const;

export type NangoSyncRecoverySource =
  | "auth"
  | "self-heal"
  | "status-poll"
  | "integration-list"
  | "sync-refresh";

export type NangoSyncSubscriptionRecoveryStatus =
  | "not_stale_pending"
  | "skipped_not_nango"
  | "skipped_missing_connection"
  | "skipped_inactive_oauth"
  | "skipped_no_syncs"
  | "re_registered"
  | "failed";

export type NangoSyncSubscriptionRecoveryResult = {
  status: NangoSyncSubscriptionRecoveryStatus;
  provider: string;
  connectionId?: string;
  providerConfigKey?: string;
  syncs: string[];
  pendingState?: string;
  lastEventAt?: string | null;
  staleForMs?: number | null;
  scheduleStatuses: Array<{ name: string; status: string | null }>;
  slackDiscoveryTriggered?: boolean;
  error?: string;
};

export type RecoverStalePendingNangoSyncSubscriptionDeps = {
  now?: () => number;
  fetchProviderSyncStatus?: typeof fetchWorkspaceProviderSyncStatus;
  getConnection?: typeof getNangoConnection;
  getScheduleStatuses?: typeof getNangoSyncScheduleStatuses;
  pauseSchedules?: typeof pauseNangoSyncSchedules;
  startSchedules?: typeof startNangoSyncSchedules;
  triggerSyncs?: typeof triggerNangoSyncs;
};

export type StalePendingSyncSummary = {
  stale: boolean;
  lastEventAt: string | null;
  staleForMs: number | null;
  thresholdMs: number;
};

function readPayloadError(payload: Record<string, unknown> | null | undefined): string | null {
  const error = payload?.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  const message = payload?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function parseEventTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function stalePendingSyncLastEventAt(input: {
  readiness: ProviderReadiness;
  initialSync: ProviderReadiness["initialSync"];
  writeback: WritebackHealth;
}): string | null {
  return (
    input.writeback.webhookHealth.lastEventAt ??
    input.writeback.watermarkTs ??
    input.initialSync.completedAt ??
    input.readiness.updatedAt ??
    null
  );
}

export function summarizeStalePendingSync(input: {
  state: ProviderState;
  readiness: ProviderReadiness;
  initialSync: ProviderReadiness["initialSync"];
  writeback: WritebackHealth;
  now?: Date;
  thresholdMs?: number;
}): StalePendingSyncSummary {
  const thresholdMs = input.thresholdMs ?? STALE_PENDING_SYNC_THRESHOLD_MS;
  const lastEventAt = stalePendingSyncLastEventAt(input);
  if (input.state !== "pending" || !lastEventAt) {
    return { stale: false, lastEventAt, staleForMs: null, thresholdMs };
  }

  const eventTime = parseEventTime(lastEventAt);
  if (eventTime === null) {
    return { stale: false, lastEventAt, staleForMs: null, thresholdMs };
  }

  const staleForMs = Math.max(0, (input.now ?? new Date()).getTime() - eventTime);
  return {
    stale: staleForMs >= thresholdMs,
    lastEventAt,
    staleForMs,
    thresholdMs,
  };
}

export function warnIfStalePendingSync(input: {
  workspaceId: string;
  provider: string;
  connectionId?: string | null;
  providerConfigKey?: string | null;
  source: NangoSyncRecoverySource;
  state: ProviderState;
  readiness: ProviderReadiness;
  initialSync: ProviderReadiness["initialSync"];
  writeback: WritebackHealth;
}): StalePendingSyncSummary {
  const stale = summarizeStalePendingSync(input);
  if (stale.stale) {
    console.warn("Workspace provider sync is stale pending", {
      workspaceId: input.workspaceId,
      provider: input.provider,
      connectionId: input.connectionId ?? null,
      providerConfigKey: input.providerConfigKey ?? null,
      source: input.source,
      lastEventAt: stale.lastEventAt,
      staleForMs: stale.staleForMs,
      thresholdMs: stale.thresholdMs,
    });
  }
  return stale;
}

function isNangoBacked(integration: WorkspaceIntegrationRecord): boolean {
  return typeof integration.providerConfigKey === "string" &&
    integration.providerConfigKey.trim().length > 0;
}

function providerConfigKeyFor(integration: WorkspaceIntegrationRecord): string | null {
  const metadata = integration.metadata &&
    typeof integration.metadata === "object" &&
    !Array.isArray(integration.metadata)
    ? integration.metadata
    : {};
  return integration.providerConfigKey?.trim() ||
    readProviderReadiness(metadata)?.providerConfigKey ||
    null;
}

function stalePendingResult(input: {
  integration: WorkspaceIntegrationRecord;
  providerConfigKey?: string;
  syncs?: string[];
  status: NangoSyncSubscriptionRecoveryStatus;
  pendingState?: string;
  lastEventAt?: string | null;
  staleForMs?: number | null;
  scheduleStatuses?: Array<{ name: string; status: string | null }>;
  slackDiscoveryTriggered?: boolean;
  error?: string;
}): NangoSyncSubscriptionRecoveryResult {
  return {
    status: input.status,
    provider: input.integration.provider,
    connectionId: input.integration.connectionId || undefined,
    providerConfigKey: input.providerConfigKey,
    syncs: input.syncs ?? [],
    pendingState: input.pendingState,
    lastEventAt: input.lastEventAt,
    staleForMs: input.staleForMs,
    scheduleStatuses: input.scheduleStatuses ?? [],
    slackDiscoveryTriggered: input.slackDiscoveryTriggered,
    error: input.error,
  };
}

function shouldTriggerSlackDiscoverySync(input: {
  provider: string;
  providerConfigKey: string;
}): boolean {
  const providerConfigKey = input.providerConfigKey.trim().toLowerCase();
  return input.provider === "slack" || providerConfigKey === "slack-relay";
}

async function triggerSlackDiscoverySyncOnce(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string;
  source: NangoSyncRecoverySource;
  triggerSyncs?: typeof triggerNangoSyncs;
}): Promise<boolean> {
  if (!shouldTriggerSlackDiscoverySync(input)) {
    return false;
  }

  const syncs = [...SLACK_DISCOVERY_SYNC_NAMES];
  const triggerSyncs = input.triggerSyncs ?? triggerNangoSyncs;
  const result = await triggerSyncs({
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
    syncs,
    syncMode: "full_refresh",
  }).catch((error) => ({
    ok: false as const,
    status: 0,
    payload: { error: error instanceof Error ? error.message : String(error) },
  }));

  if (!result.ok) {
    await logger.warn("Slack discovery sync trigger failed", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      provider: input.provider,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      source: input.source,
      syncs,
      status: result.status,
      error: readPayloadError(result.payload),
    });
    return false;
  }

  await logger.info("Slack discovery sync triggered", {
    area: "nango-webhook",
    workspaceId: input.workspaceId,
    provider: input.provider,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    source: input.source,
    syncs,
  });
  return true;
}

export async function ensureWorkspaceNangoSyncSchedules(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string;
  source: NangoSyncRecoverySource;
  startSchedules?: typeof startNangoSyncSchedules;
  triggerSyncs?: typeof triggerNangoSyncs;
}): Promise<{ ok: boolean; syncs: string[]; slackDiscoveryTriggered: boolean; status?: number; error?: string }> {
  const startSchedules = input.startSchedules ?? startNangoSyncSchedules;
  const started = await startSchedules({
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
  }).catch((error) => ({
    ok: false,
    syncs: [],
    status: 0,
    payload: { error: error instanceof Error ? error.message : String(error) },
  }));

  if (!started.ok) {
    const error = readPayloadError(started.payload) ?? undefined;
    await logger.warn("Nango sync schedule start failed", {
      area: "nango-webhook",
      workspaceId: input.workspaceId,
      provider: input.provider,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      source: input.source,
      syncs: started.syncs,
      status: started.status,
      error,
    });
    return {
      ok: false,
      syncs: started.syncs,
      status: started.status,
      error,
      slackDiscoveryTriggered: false,
    };
  }

  await logger.info("Nango sync schedules ensured", {
    area: "nango-webhook",
    workspaceId: input.workspaceId,
    provider: input.provider,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    source: input.source,
    syncs: started.syncs,
  });

  return {
    ok: true,
    syncs: started.syncs,
    slackDiscoveryTriggered: await triggerSlackDiscoverySyncOnce(input),
  };
}

export async function recoverStalePendingNangoSyncSubscription(
  integration: WorkspaceIntegrationRecord,
  deps: RecoverStalePendingNangoSyncSubscriptionDeps = {},
): Promise<NangoSyncSubscriptionRecoveryResult> {
  const now = deps.now?.() ?? Date.now();
  const providerConfigKey = providerConfigKeyFor(integration);
  if (!isNangoBacked(integration) || !providerConfigKey) {
    return stalePendingResult({
      integration,
      status: "skipped_not_nango",
    });
  }

  const connectionId = typeof integration.connectionId === "string"
    ? integration.connectionId.trim()
    : "";
  if (!connectionId) {
    return stalePendingResult({
      integration,
      providerConfigKey,
      status: "skipped_missing_connection",
    });
  }

  const fetchProviderSyncStatus =
    deps.fetchProviderSyncStatus ?? fetchWorkspaceProviderSyncStatus;
  const relayfileStatus = await fetchProviderSyncStatus(
    integration.workspaceId,
    integration.provider,
  ).catch(() => null);
  const writeback = summarizeWritebackHealth(relayfileStatus);
  const readiness =
    readProviderReadiness(
      integration.metadata &&
        typeof integration.metadata === "object" &&
        !Array.isArray(integration.metadata)
        ? integration.metadata
        : {},
    ) ??
    buildLegacyConnectedReadiness({
      connectionId,
      providerConfigKey,
    });
  const definition = isWorkspaceIntegrationProvider(integration.provider)
    ? getWorkspaceIntegrationProviderDefinition(integration.provider)
    : null;
  const initialSync = summarizeProviderInitialSync({
    readiness,
    providerConfigKey: definition?.defaultConfigKey ?? providerConfigKey,
  });
  const providerState = deriveProviderState({ initialSync, writeback });
  const lastEventAt =
    writeback.watermarkTs ??
    writeback.webhookHealth.lastEventAt ??
    initialSync.completedAt ??
    readiness.updatedAt;
  const eventTime = parseEventTime(lastEventAt);
  const staleForMs = eventTime === null ? null : Math.max(0, now - eventTime);
  const isStale =
    eventTime === null ||
    (staleForMs !== null && staleForMs >= STALE_PENDING_SYNC_THRESHOLD_MS);

  if (providerState !== "pending" || !isStale) {
    return stalePendingResult({
      integration,
      providerConfigKey,
      status: "not_stale_pending",
      pendingState: providerState,
      lastEventAt,
      staleForMs,
    });
  }

  const getConnection = deps.getConnection ?? getNangoConnection;
  const connection = await getConnection(connectionId, providerConfigKey, {
    provider: integration.provider,
  });
  if (!connection || connection.status === "inactive") {
    return stalePendingResult({
      integration,
      providerConfigKey,
      status: "skipped_inactive_oauth",
      pendingState: providerState,
      lastEventAt,
      staleForMs,
      error: connection ? "Nango connection is inactive" : "Nango connection not found",
    });
  }

  const syncs = getEnabledNangoSyncNamesForProviderConfigKey(providerConfigKey);
  if (syncs.length === 0) {
    return stalePendingResult({
      integration,
      providerConfigKey,
      status: "skipped_no_syncs",
      pendingState: providerState,
      lastEventAt,
      staleForMs,
    });
  }

  const getScheduleStatuses =
    deps.getScheduleStatuses ?? getNangoSyncScheduleStatuses;
  const scheduleSnapshot = await getScheduleStatuses({
    providerConfigKey,
    connectionId,
    syncs,
  }).catch(() => ({ ok: false, syncs: [] }));
  const scheduleStatuses = scheduleSnapshot.syncs.map((entry) => ({
    name: entry.name,
    status: entry.status,
  }));

  const pauseSchedules = deps.pauseSchedules ?? pauseNangoSyncSchedules;
  const startSchedules = deps.startSchedules ?? startNangoSyncSchedules;
  const paused = await pauseSchedules({
    providerConfigKey,
    connectionId,
    syncs,
  });
  if (!paused.ok) {
    return stalePendingResult({
      integration,
      providerConfigKey,
      syncs,
      status: "failed",
      pendingState: providerState,
      lastEventAt,
      staleForMs,
      scheduleStatuses,
      error: `Nango /sync/pause returned ${paused.status ?? "unknown"}${
        readPayloadError(paused.payload) ? `: ${readPayloadError(paused.payload)}` : ""
      }`,
    });
  }

  const started = await startSchedules({
    providerConfigKey,
    connectionId,
    syncs,
  });
  if (!started.ok) {
    return stalePendingResult({
      integration,
      providerConfigKey,
      syncs,
      status: "failed",
      pendingState: providerState,
      lastEventAt,
      staleForMs,
      scheduleStatuses,
      error: `Nango /sync/start returned ${started.status ?? "unknown"}${
        readPayloadError(started.payload) ? `: ${readPayloadError(started.payload)}` : ""
      }`,
    });
  }

  const slackDiscoveryTriggered = await triggerSlackDiscoverySyncOnce({
    workspaceId: integration.workspaceId,
    provider: integration.provider,
    connectionId,
    providerConfigKey,
    source: "sync-refresh",
    triggerSyncs: deps.triggerSyncs,
  });

  return stalePendingResult({
    integration,
    providerConfigKey,
    syncs: started.syncs,
    status: "re_registered",
    pendingState: providerState,
    lastEventAt,
    staleForMs,
    scheduleStatuses,
    slackDiscoveryTriggered,
  });
}
