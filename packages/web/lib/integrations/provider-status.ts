import { mintScopedRelayfileToken } from "@cloud/core/relayfile/client.js";
import type { SyncProviderStatus, SyncStatusResponse } from "@relayfile/sdk";
import {
  aggregateProviderInitialSync,
  type ProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import { enabledGeneratedNangoProviderModelsForProviderConfigKey } from "@cloud/core/sync/nango-provider-parity.js";
import { resolveRelayfileConfig } from "@/lib/relayfile";

// Watermark older than 10 minutes promotes a complete-but-lagging
// provider from `ready` to `degraded` per contract §7.1.
const DEGRADED_LAG_THRESHOLD_SECONDS = 600;

export type ProviderState =
  | "pending"
  | "cataloging"
  | "syncing"
  | "ready"
  | "error"
  | "degraded";

export type WritebackHealthState =
  | "healthy"
  | "lagging"
  | "error"
  | "paused"
  | "unknown";

export type WebhookHealth = {
  healthy: boolean;
  lastEventAt: string | null;
  lastError: string | null;
};

export type WritebackHealth = {
  state: WritebackHealthState;
  lagSeconds: number | null;
  watermarkTs: string | null;
  lastError: string | null;
  deadLetteredEnvelopes: number;
  deadLetteredOps: number;
  failureCodes: Record<string, number>;
  webhookHealthy: boolean | null;
  webhookHealth: WebhookHealth;
};

function readWebhookHealthy(value: SyncProviderStatus): boolean | null {
  // The upstream SDK type does not yet declare `webhookHealthy`; the
  // productized cloud-mount contract requires we forward it when present.
  const candidate = (value as { webhookHealthy?: unknown }).webhookHealthy;
  return typeof candidate === "boolean" ? candidate : null;
}

function readWebhookHealth(
  providerStatus: SyncProviderStatus | null,
): WebhookHealth {
  if (!providerStatus) {
    return {
      healthy: false,
      lastEventAt: null,
      lastError: "No provider sync status is available",
    };
  }

  const webhookHealthy = readWebhookHealthy(providerStatus);
  const eventAt = (providerStatus as { webhookLastEventAt?: unknown })
    .webhookLastEventAt;
  const error = (providerStatus as { webhookLastError?: unknown })
    .webhookLastError;
  return {
    healthy: webhookHealthy === true,
    lastEventAt: typeof eventAt === "string" && eventAt.trim() ? eventAt : null,
    lastError:
      typeof error === "string" && error.trim()
        ? error
        : webhookHealthy === null
          ? "No webhook health signal has been reported by Relayfile"
          : null,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function fetchWorkspaceProviderSyncStatus(
  workspaceId: string,
  provider: string,
): Promise<SyncProviderStatus | null> {
  const { relayfileUrl, relayAuthApiKey, relayAuthUrl } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    return null;
  }

  const token = await mintScopedRelayfileToken({
    workspaceId,
    agentName: "cloud-provider-status",
    relayAuthUrl,
    relayAuthApiKey,
    scopes: ["sync:read"],
  });

  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/status`,
    `${trimTrailingSlash(relayfileUrl)}/`,
  );
  url.searchParams.set("provider", provider);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Correlation-Id": `cloud-provider-status:${workspaceId}:${provider}`,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as SyncStatusResponse;
  return body.providers.find((entry) => entry.provider === provider) ?? null;
}

export async function reportWorkspaceProviderWebhookHealth(input: {
  workspaceId: string;
  provider: string;
  healthy: boolean;
  eventAt?: string;
  error?: string | null;
}): Promise<boolean> {
  const { relayfileUrl, relayAuthApiKey, relayAuthUrl } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    return false;
  }

  const token = await mintScopedRelayfileToken({
    workspaceId: input.workspaceId,
    agentName: "cloud-webhook-health",
    relayAuthUrl,
    relayAuthApiKey,
    scopes: ["sync:trigger"],
  });

  const url = new URL(
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sync/webhook-health`,
    `${trimTrailingSlash(relayfileUrl)}/`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Correlation-Id": `cloud-webhook-health:${input.workspaceId}:${input.provider}`,
    },
    body: JSON.stringify({
      provider: input.provider,
      healthy: input.healthy,
      eventAt: input.eventAt,
      error: input.error ?? null,
    }),
    cache: "no-store",
  });

  return response.ok;
}

export function summarizeWritebackHealth(
  providerStatus: SyncProviderStatus | null,
): WritebackHealth {
  if (!providerStatus) {
    return {
      state: "unknown",
      lagSeconds: null,
      watermarkTs: null,
      lastError: null,
      deadLetteredEnvelopes: 0,
      deadLetteredOps: 0,
      failureCodes: {},
      webhookHealthy: null,
      webhookHealth: readWebhookHealth(null),
    };
  }

  const deadLetteredEnvelopes = providerStatus.deadLetteredEnvelopes ?? 0;
  const deadLetteredOps = providerStatus.deadLetteredOps ?? 0;
  const lastError = providerStatus.lastError ?? null;
  const lagSeconds = providerStatus.lagSeconds ?? null;
  let state: WritebackHealthState = "healthy";

  if (providerStatus.status === "paused") {
    state = "paused";
  } else if (
    providerStatus.status === "error" ||
    deadLetteredOps > 0 ||
    lastError
  ) {
    state = "error";
  } else if (providerStatus.status === "lagging" || deadLetteredEnvelopes > 0) {
    state = "lagging";
  }

  return {
    state,
    lagSeconds,
    watermarkTs: providerStatus.watermarkTs ?? null,
    lastError,
    deadLetteredEnvelopes,
    deadLetteredOps,
    failureCodes: providerStatus.failureCodes ?? {},
    webhookHealthy: readWebhookHealthy(providerStatus),
    webhookHealth: readWebhookHealth(providerStatus),
  };
}

export function summarizeProviderInitialSync(input: {
  readiness: ProviderReadiness;
  providerConfigKey?: string | null;
}): ProviderReadiness["initialSync"] {
  const expectedModelKeys = enabledGeneratedNangoProviderModelsForProviderConfigKey(
    input.providerConfigKey ?? input.readiness.providerConfigKey,
  ).map((entry) => entry.key);
  return aggregateProviderInitialSync({
    initialSync: input.readiness.initialSync,
    expectedModelKeys,
  });
}

// Maps cloud's initial-sync axis (queued/running/complete/failed) and
// relayfile's writeback axis (healthy/lagging/error/paused) onto the
// productized cloud-mount contract enum (§7.1).
export function deriveProviderState(input: {
  initialSync: ProviderReadiness["initialSync"];
  writeback: WritebackHealth;
}): ProviderState {
  const { initialSync, writeback } = input;
  const hasModelAwareInitialSync = Object.keys(initialSync.byModel).length > 0;

  if (initialSync.state === "failed" || writeback.state === "error") {
    return "error";
  }

  if (initialSync.state === "complete") {
    if (
      writeback.state === "lagging" &&
      writeback.lagSeconds !== null &&
      writeback.lagSeconds > DEGRADED_LAG_THRESHOLD_SECONDS
    ) {
      return "degraded";
    }
    if (writeback.state === "paused") {
      // Initial sync done, but writeback is paused — surface as degraded
      // so callers don't treat the integration as fully ready for writes.
      return "degraded";
    }
    return "ready";
  }

  if (initialSync.state === "running") {
    return "syncing";
  }

  // A connect-session placeholder can stay `queued` if an auth webhook is
  // missed, even though the Nango sync worker has materialized provider state
  // in Relayfile. Relayfile sync status is the runtime-visible truth for
  // mounted agents, so a healthy upstream status with an observed lag or
  // watermark promotes legacy scalar-only rows to ready instead of leaving
  // deploy stuck on stale pending metadata. Model-aware rows must not take
  // this shortcut: a single model write can create a watermark before every
  // expected model has completed.
  if (
    !hasModelAwareInitialSync &&
    writeback.state === "healthy" &&
    (writeback.watermarkTs !== null || writeback.lagSeconds !== null)
  ) {
    return "ready";
  }

  // Cloud's `queued` covers the gap between OAuth completion and sync
  // start. The contract reserves `cataloging` for "actively listing remote
  // objects" — we cannot distinguish that from materializing inside a
  // running Nango sync, so we never emit `cataloging`.
  return "pending";
}

// Resilience signal for the status route: did the *live* Nango sync schedule
// report every sync SUCCESS? The persisted readiness blob only advances to
// `complete` when the durable sync-completion pipeline runs (Nango sync
// webhook -> `nango_sync` job -> `markProviderInitialSyncComplete`). If that
// pipeline is degraded, the blob can stay `queued` indefinitely even though
// Nango has already finished every sync and the upstream data IS present.
// When this returns true the status route promotes the productized state to
// reflect a complete initial sync (and flags the persisted blob as stale so
// the underlying pipeline gap is never silently masked).
//
// Requires at least one sync and ALL syncs SUCCESS: a partial/empty result is
// not enough to claim the initial sync finished. A null/!ok schedule (the
// fetch failed, or the backend isn't Nango) yields false — we only promote on
// positive live evidence.
export function liveNangoInitialSyncSucceeded(
  schedules: { ok: boolean; syncs: Array<{ status: string | null }> } | null,
): boolean {
  return (
    schedules?.ok === true &&
    schedules.syncs.length > 0 &&
    schedules.syncs.every((sync) => sync.status === "SUCCESS")
  );
}
