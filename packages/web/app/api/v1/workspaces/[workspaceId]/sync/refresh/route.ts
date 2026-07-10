import { NextRequest, NextResponse } from "next/server";
import { ensureProviderDiscoveryContractReport } from "@cloud/core/sync/record-writer.js";
import { enabledGeneratedNangoProviderModelsForProviderConfigKey } from "@cloud/core/sync/nango-provider-parity.js";
import type { NangoSyncJob } from "@cloud/core/sync/nango-sync-job.js";
import { createGitHubRelayfileClient } from "@/lib/integrations/github-relayfile";
import {
  recoverStalePendingNangoSyncSubscription,
  type NangoSyncSubscriptionRecoveryResult,
} from "@/lib/integrations/nango-sync-subscription-recovery";
import { enqueueNangoSyncJob } from "@/lib/integrations/nango-sync-queue";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  hasWorkspaceAccess,
  resolveWorkspaceUuid,
} from "@/lib/integrations/integration-route-handler";
import {
  getProviderConfigKey,
  isWorkspaceIntegrationProvider,
  type WorkspaceIntegrationProvider,
} from "@/lib/integrations/providers";
import {
  listWorkspaceIntegrations,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ErrorResponse = { error: string };

type RefreshProviderResult = {
  provider: string;
  discoveryBackfilled: boolean;
  discoveryBackfillStatus:
    | "complete"
    | "skipped-no-records"
    | "degraded"
    | "failed"
    | "timeout";
  errors: number;
  durationMs: number;
  timedOut?: boolean;
  syncSubscriptionRecovery?: NangoSyncSubscriptionRecoveryResult;
  materializationBackfill?: {
    status: "queued" | "skipped" | "failed";
    jobsQueued: number;
    reason?: string;
    errors?: string[];
  };
  samplingWarnings: Array<{
    resourceName: string;
    resourcePath: string;
    indexPath: string;
    indexRows: number;
    sampledIds: number;
    sampledRecords: number;
    reason: string;
  }>;
};

type MaterializationBackfillResult = NonNullable<
  RefreshProviderResult["materializationBackfill"]
>;

type RefreshResponse = {
  workspaceId: string;
  refreshed: RefreshProviderResult[];
  errors: Array<{
    provider?: string;
    reason: "provider_failed" | "provider_timeout" | "request_timeout";
    message: string;
    durationMs?: number;
  }>;
  durationMs: number;
  timedOut: boolean;
};

export const SYNC_REFRESH_PROVIDER_CONCURRENCY = 4;
export const SYNC_REFRESH_PROVIDER_TIMEOUT_MS = 30_000;
export const SYNC_REFRESH_REQUEST_TIMEOUT_MS = 90_000;

type RelayfileClient = ReturnType<typeof createGitHubRelayfileClient>;

function elapsedSince(startedAt: number): number {
  return Date.now() - startedAt;
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  value: () => T,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(value()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerConfigKeyForIntegration(
  integration: WorkspaceIntegrationRecord,
): string | null {
  const configured = integration.providerConfigKey?.trim();
  if (configured) {
    return configured;
  }
  if (!isWorkspaceIntegrationProvider(integration.provider)) {
    return null;
  }
  return getProviderConfigKey(integration.provider as WorkspaceIntegrationProvider);
}

function isComposioStyleConnectionId(connectionId: string): boolean {
  return /^ca_[A-Za-z0-9_-]+$/u.test(connectionId.trim());
}

async function enqueueProviderMaterializationBackfill(
  integration: WorkspaceIntegrationRecord,
  workspaceId: string,
): Promise<MaterializationBackfillResult> {
  const provider = integration.provider;
  const connectionId = integration.connectionId?.trim();
  if (!connectionId) {
    return { status: "skipped", jobsQueued: 0, reason: "missing_connection_id" };
  }
  if (isComposioStyleConnectionId(connectionId)) {
    return { status: "skipped", jobsQueued: 0, reason: "non_nango_connection_id" };
  }

  const providerConfigKey = providerConfigKeyForIntegration(integration);
  if (!providerConfigKey) {
    return {
      status: "skipped",
      jobsQueued: 0,
      reason: "missing_provider_config_key",
    };
  }

  const models =
    enabledGeneratedNangoProviderModelsForProviderConfigKey(providerConfigKey);
  if (models.length === 0) {
    return { status: "skipped", jobsQueued: 0, reason: "no_enabled_models" };
  }

  const errors: string[] = [];
  let jobsQueued = 0;
  for (const model of models) {
    const job = {
      type: "nango_sync",
      provider,
      connectionId,
      providerConfigKey,
      syncName: model.sync,
      model: model.model,
      modifiedAfter: null,
      syncType: "INITIAL",
      checkpoints: { from: null, to: null },
      cursor: null,
      workspaceId: integration.workspaceId || workspaceId,
      ...(workspaceId !== integration.workspaceId
        ? { relayWorkspaceId: workspaceId }
        : {}),
    };
    try {
      await enqueueNangoSyncJob(job as unknown as NangoSyncJob);
      jobsQueued += 1;
    } catch (error) {
      errors.push(`${model.sync}:${model.model}:${formatError(error)}`);
    }
  }

  if (errors.length > 0) {
    return {
      status: "failed",
      jobsQueued,
      errors,
    };
  }
  return { status: "queued", jobsQueued };
}

async function refreshProvider(
  client: RelayfileClient,
  integration: WorkspaceIntegrationRecord,
  workspaceId: string,
): Promise<RefreshProviderResult> {
  const startedAt = Date.now();
  const provider = integration.provider;
  const refresh = (async (): Promise<RefreshProviderResult> => {
    const [
      discoveryResult,
      syncSubscriptionRecovery,
      materializationBackfill,
    ] = await Promise.all([
      ensureProviderDiscoveryContractReport(
        client,
        provider,
        workspaceId,
      )
        .then((report) => ({
          // Registry-backed nango providers materialize the discovery contract;
          // status distinguishes real sampling from empty or degraded samples so
          // refresh callers can spot silent empty schemas.
          discoveryBackfilled: true,
          discoveryBackfillStatus: report.status,
          errors: report.errors.length,
          samplingWarnings: report.samplingWarnings.map((warning) => ({
            resourceName: warning.resourceName,
            resourcePath: warning.resourcePath,
            indexPath: warning.indexPath,
            indexRows: warning.indexRows,
            sampledIds: warning.sampledIds,
            sampledRecords: warning.sampledRecords,
            reason: warning.reason,
          })),
        }))
        .catch((error) => {
          console.error("Workspace sync refresh discovery backfill failed:", {
            workspaceId,
            provider,
            durationMs: elapsedSince(startedAt),
            error: formatError(error),
          });
          return {
            discoveryBackfilled: false,
            discoveryBackfillStatus: "failed" as const,
            errors: 1,
            samplingWarnings: [],
          };
        }),
      recoverStalePendingNangoSyncSubscription(integration).catch(
        (error): NangoSyncSubscriptionRecoveryResult => ({
          provider,
          status: "failed",
          syncs: [],
          scheduleStatuses: [],
          error: formatError(error),
        }),
      ),
      enqueueProviderMaterializationBackfill(integration, workspaceId).catch(
        (error) => ({
          status: "failed" as const,
          jobsQueued: 0,
          errors: [formatError(error)],
        }),
      ),
    ]);

    if (syncSubscriptionRecovery.status === "failed") {
      console.warn("Workspace sync refresh subscription recovery failed:", {
        workspaceId,
        provider,
        connectionId: syncSubscriptionRecovery.connectionId,
        providerConfigKey: syncSubscriptionRecovery.providerConfigKey,
        error: syncSubscriptionRecovery.error,
      });
    } else if (syncSubscriptionRecovery.status === "re_registered") {
      console.info("Workspace sync refresh subscription re-registered:", {
        workspaceId,
        provider,
        connectionId: syncSubscriptionRecovery.connectionId,
        providerConfigKey: syncSubscriptionRecovery.providerConfigKey,
        syncs: syncSubscriptionRecovery.syncs,
        lastEventAt: syncSubscriptionRecovery.lastEventAt,
        staleForMs: syncSubscriptionRecovery.staleForMs,
      });
    } else if (
      syncSubscriptionRecovery.status !== "not_stale_pending" &&
      syncSubscriptionRecovery.status !== "skipped_not_nango"
    ) {
      console.warn("Workspace sync refresh subscription recovery skipped:", {
        workspaceId,
        provider,
        status: syncSubscriptionRecovery.status,
        connectionId: syncSubscriptionRecovery.connectionId,
        providerConfigKey: syncSubscriptionRecovery.providerConfigKey,
        lastEventAt: syncSubscriptionRecovery.lastEventAt,
        staleForMs: syncSubscriptionRecovery.staleForMs,
        error: syncSubscriptionRecovery.error,
      });
    }

    return {
      provider,
      // Registry-backed nango providers materialize the discovery contract;
      // status distinguishes real sampling from empty or degraded samples so
      // refresh callers can spot silent empty schemas.
      discoveryBackfilled: discoveryResult.discoveryBackfilled,
      discoveryBackfillStatus: discoveryResult.discoveryBackfillStatus,
      errors:
        discoveryResult.errors +
        (syncSubscriptionRecovery.status === "failed" ? 1 : 0) +
        (materializationBackfill.status === "failed" ? 1 : 0),
      durationMs: elapsedSince(startedAt),
      ...(syncSubscriptionRecovery.status !== "skipped_not_nango" &&
      syncSubscriptionRecovery.status !== "not_stale_pending"
        ? { syncSubscriptionRecovery }
        : {}),
      ...(materializationBackfill.status !== "skipped"
        ? { materializationBackfill }
        : {}),
      samplingWarnings: discoveryResult.samplingWarnings,
    };
  })();

  const result = await raceWithTimeout(
    refresh,
    SYNC_REFRESH_PROVIDER_TIMEOUT_MS,
    (): RefreshProviderResult => ({
      provider,
      discoveryBackfilled: false,
      discoveryBackfillStatus: "timeout",
      errors: 1,
      durationMs: elapsedSince(startedAt),
      timedOut: true,
      samplingWarnings: [],
    }),
  );

  const logPayload = {
    workspaceId,
    provider,
    status: result.discoveryBackfillStatus,
    discoveryBackfilled: result.discoveryBackfilled,
    errors: result.errors,
    durationMs: result.durationMs,
    timedOut: result.timedOut === true,
  };
  if (result.timedOut) {
    console.warn("Workspace sync refresh provider timed out:", logPayload);
  } else {
    console.info("Workspace sync refresh provider completed:", logPayload);
  }
  return result;
}

async function refreshProviders(
  client: RelayfileClient,
  integrations: WorkspaceIntegrationRecord[],
  workspaceId: string,
  results: Array<RefreshProviderResult | undefined>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(
    SYNC_REFRESH_PROVIDER_CONCURRENCY,
    integrations.length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < integrations.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await refreshProvider(
          client,
          integrations[index],
          workspaceId,
        );
      }
    }),
  );
}

/**
 * POST .../sync/refresh — discovery-contract (re)materialization touchpoint.
 *
 * This route (re)materializes the writeback DISCOVERY CONTRACT surface
 * (the LAYOUT advertiser + `discovery/<provider>/.../` schema/example/adapter
 * producer) for every connected nango provider in the workspace. It also
 * re-registers Nango sync schedules for OAuth-healthy providers stuck in stale
 * `pending`, then kicks Slack discovery syncs so manual refresh can recover
 * authorized-but-not-subscribed Slack workspaces without a re-OAuth.
 *
 * It closes the live `rw_fc7b534b` gap: an already-fully-synced workspace's
 * next sync is a no-op and the sync worker only runs when Nango fires a
 * `sync` webhook, so #745's "backfill on next sync" never fired for it. An
 * operator refresh of this route now backfills discovery directly; stale
 * pending providers additionally get an upstream Nango schedule re-registration.
 *
 * Nango-only by construction: `ensureProviderDiscoveryContractReport` is
 * gated on the single `ADAPTERS` registry and returns immediately for any
 * provider not in it (Composio/x untouched). Byte-stable: it reuses the same
 * monotonic-merge + canonicalize + `writeManagedFile` dedup as the sync
 * path, so repeated refreshes do not churn revisions/writeback/events.
 *
 * Auth: strict `hasWorkspaceAccess` (same guard as sibling mutating routes),
 * enforced BEFORE any side effect — no `listWorkspaceIntegrations` call and
 * no write happens until the caller is authenticated AND a workspace member.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId: rawWorkspaceId } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Parity with sibling integration routes: a Slack-team-id path form
  // resolves to the canonical workspace id the same way other workspace
  // routes do. Plain `rw_<hex>` / UUID forms pass through unchanged.
  const workspaceId = await resolveWorkspaceUuid(rawWorkspaceId);
  if (!workspaceId) {
    return NextResponse.json<ErrorResponse>(
      { error: "Invalid workspaceId" },
      { status: 400 },
    );
  }

  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  try {
    const startedAt = Date.now();
    let providers: string[] = [];
    let providerIntegrations: WorkspaceIntegrationRecord[] = [];
    const results: Array<RefreshProviderResult | undefined> = [];
    const refreshWork = (async () => {
      const integrations = await listWorkspaceIntegrations(workspaceId);
      const seenProviders = new Set<string>();
      providerIntegrations = integrations.filter((integration) => {
        if (!isWorkspaceIntegrationProvider(integration.provider)) {
          return false;
        }
        if (seenProviders.has(integration.provider)) {
          return false;
        }
        seenProviders.add(integration.provider);
        return true;
      });
      providers = providerIntegrations.map((integration) => integration.provider);
      results.length = providerIntegrations.length;
      const client = createGitHubRelayfileClient(workspaceId);
      await refreshProviders(client, providerIntegrations, workspaceId, results);
    })();
    const requestTimedOut = await raceWithTimeout(
      refreshWork.then(() => false),
      SYNC_REFRESH_REQUEST_TIMEOUT_MS,
      () => true,
    );
    const refreshed = results.filter(
      (result): result is RefreshProviderResult => Boolean(result),
    );
    const pendingProviders = requestTimedOut
      ? providers.filter((_provider, index) => !results[index])
      : [];
    const durationMs = elapsedSince(startedAt);
    const errors: RefreshResponse["errors"] = [];
    if (requestTimedOut && providers.length === 0) {
      errors.push({
        reason: "request_timeout",
        message: `Sync refresh request timed out before integrations could be listed after ${SYNC_REFRESH_REQUEST_TIMEOUT_MS}ms`,
        durationMs,
      });
    }
    for (const result of refreshed) {
      if (result.discoveryBackfillStatus === "timeout") {
        errors.push({
          provider: result.provider,
          reason: "provider_timeout",
          message: `Discovery backfill timed out after ${SYNC_REFRESH_PROVIDER_TIMEOUT_MS}ms`,
          durationMs: result.durationMs,
        });
      } else if (result.discoveryBackfillStatus === "failed") {
        errors.push({
          provider: result.provider,
          reason: "provider_failed",
          message: "Discovery backfill failed",
          durationMs: result.durationMs,
        });
      }
      if (result.syncSubscriptionRecovery?.status === "failed") {
        errors.push({
          provider: result.provider,
          reason: "provider_failed",
          message:
            result.syncSubscriptionRecovery.error ??
            "Nango sync subscription recovery failed",
          durationMs: result.durationMs,
        });
      }
      if (
        result.materializationBackfill?.status === "failed" &&
        result.timedOut !== true
      ) {
        errors.push({
          provider: result.provider,
          reason: "provider_failed",
          message:
            result.materializationBackfill.errors?.join("; ") ??
            "Nango materialization backfill enqueue failed",
          durationMs: result.durationMs,
        });
      }
    }
    for (const provider of pendingProviders) {
      errors.push({
        provider,
        reason: "request_timeout",
        message: `Sync refresh request timed out before provider completed after ${SYNC_REFRESH_REQUEST_TIMEOUT_MS}ms`,
        durationMs: elapsedSince(startedAt),
      });
    }

    const timedOut =
      requestTimedOut || refreshed.some((result) => result.timedOut === true);
    console.info("Workspace sync refresh completed:", {
      workspaceId,
      providers: providers.length,
      refreshed: refreshed.length,
      errors: errors.length,
      timedOut,
      durationMs,
    });

    return NextResponse.json<RefreshResponse>(
      { workspaceId, refreshed, errors, durationMs, timedOut },
      {
        status: timedOut ? 504 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("Workspace sync refresh failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to refresh sync" },
      { status: 500 },
    );
  }
}
