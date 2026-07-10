import type {
  BackendStatusResponse,
  QueuedResponse,
  SyncStatusResponse,
} from "@relayfile/sdk";
import type {
  AdminSyncStatusMapResponse,
  IngressStatusMapResponse,
  IngressStatusResponse,
} from "../../types.js";
import type { Bindings } from "../../env.js";
import { fetchWorkspaceDOWithBackpressure } from "../../workspace-do-backpressure.js";
import {
  asString,
  d1First,
  d1Run,
  isReplayableOperationStatus,
  storedEnvelopeToMessage,
  type D1Context,
  type Row,
  type StoredEnvelopeRow,
} from "../d1.js";
import {
  buildIngressStatus,
  buildIngressStatusMap,
  buildSyncProviders,
  buildSyncStatusMap,
  isZeroIngressStatus,
  listWorkspaceIds,
  loadWorkspaceStats,
  type WorkspaceStatsContext,
} from "../stats.js";

export interface AdminRoute {
  segments: string[];
}

export interface AdminErrorShape {
  status: number;
  code: string;
  message: string;
}

export interface AdminHandlerContext extends D1Context, WorkspaceStatsContext {
  bindings: Bindings;
  json(body: unknown, status?: number): Response;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
  ): Response;
  correlationId(request: Request): string;
  errors: {
    notFound: AdminErrorShape;
    invalidState: AdminErrorShape;
  };
  constants: {
    ingressQueueCapacity: number;
    writebackQueueCapacity: number;
    defaultIngressAlertProfile: IngressStatusMapResponse["alertProfile"];
  };
}

export async function handleAdminRoute(
  ctx: AdminHandlerContext,
  request: Request,
  route: AdminRoute,
): Promise<Response> {
  const joined = route.segments.join("/");
  if (request.method === "GET" && joined === "backends") {
    return handleBackendStatus(ctx, request);
  }
  if (request.method === "GET" && joined === "ingress") {
    return handleAdminIngress(ctx, request);
  }
  if (request.method === "GET" && joined === "sync") {
    return handleAdminSync(ctx, request);
  }
  if (
    request.method === "POST" &&
    route.segments[0] === "replay" &&
    route.segments[1] === "envelope" &&
    route.segments.length === 3
  ) {
    return handleAdminReplayEnvelope(ctx, request, route.segments[2]);
  }
  if (
    request.method === "POST" &&
    route.segments[0] === "replay" &&
    route.segments[1] === "op" &&
    route.segments.length === 3
  ) {
    return handleAdminReplayOperation(ctx, request, route.segments[2]);
  }

  return ctx.errorResponse(
    request,
    ctx.errors.notFound.status,
    ctx.errors.notFound.code,
    "route not found",
  );
}

export async function handleBackendStatus(
  ctx: AdminHandlerContext,
  _request: Request,
): Promise<Response> {
  const suffix =
    ctx.bindings.ENVIRONMENT === "production"
      ? ""
      : `-${ctx.bindings.ENVIRONMENT}`;
  return ctx.json({
    backendProfile: "cloudflare-workers",
    stateBackend: "durable_object_sqlite+d1",
    envelopeQueue: `relayfile-envelopes${suffix}`,
    envelopeQueueDepth: 0,
    envelopeQueueCapacity: ctx.constants.ingressQueueCapacity,
    writebackQueue: `relayfile-writeback${suffix}`,
    writebackQueueDepth: 0,
    writebackQueueCapacity: ctx.constants.writebackQueueCapacity,
  } satisfies BackendStatusResponse);
}

export async function handleAdminIngress(
  ctx: AdminHandlerContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const alertProfile = (url.searchParams.get("alertProfile") ??
    ctx.constants
      .defaultIngressAlertProfile) as IngressStatusMapResponse["alertProfile"];
  const thresholds = {
    pending: clampInt(
      url.searchParams.get("pendingThreshold"),
      defaultPendingThreshold(alertProfile),
      1,
      1_000_000,
    ),
    deadLetter: clampInt(
      url.searchParams.get("deadLetterThreshold"),
      defaultDeadLetterThreshold(alertProfile),
      1,
      1_000_000,
    ),
    stale: clampInt(
      url.searchParams.get("staleThreshold"),
      defaultStaleThreshold(alertProfile),
      1,
      1_000_000,
    ),
    dropRate: clampFloat(
      url.searchParams.get("dropRateThreshold"),
      defaultDropRateThreshold(alertProfile),
      0,
      1,
    ),
  };
  const providerFilter = normalizeProvider(
    url.searchParams.get("provider") ?? undefined,
  );
  const includeWorkspaces = parseBoolean(
    url.searchParams.get("includeWorkspaces"),
    true,
  );
  const includeAlerts = parseBoolean(
    url.searchParams.get("includeAlerts"),
    true,
  );
  const nonZeroOnly = parseBoolean(url.searchParams.get("nonZeroOnly"), false);
  const maxAlerts = clampInt(url.searchParams.get("maxAlerts"), 200, 0, 10_000);
  const limit = clampInt(url.searchParams.get("limit"), 200, 1, 5_000);
  const cursor = url.searchParams.get("cursor");
  const workspaceFilter = url.searchParams.get("workspaceId")?.trim() ?? "";

  let workspaceIds = await listWorkspaceIds(ctx);
  if (workspaceFilter) {
    workspaceIds = workspaceIds.filter(
      (workspaceId) => workspaceId === workspaceFilter,
    );
  }

  workspaceIds.sort((left, right) => left.localeCompare(right));
  const totalWorkspaceCount = workspaceIds.length;
  if (cursor) {
    const index = workspaceIds.findIndex(
      (workspaceId) => workspaceId === cursor,
    );
    if (index >= 0) {
      workspaceIds = workspaceIds.slice(index + 1);
    }
  }

  const pageIds = workspaceIds.slice(0, limit);
  const nextCursor =
    workspaceIds.length > pageIds.length
      ? (pageIds[pageIds.length - 1] ?? null)
      : null;
  const resolvedWorkspaces = includeWorkspaces
    ? await (async () => {
        const workspaces: Record<string, IngressStatusResponse> = {};
        for (const workspaceId of pageIds) {
          const status = await buildIngressStatus(
            ctx,
            workspaceId,
            providerFilter || undefined,
          );
          if (nonZeroOnly && isZeroIngressStatus(status)) {
            continue;
          }
          workspaces[workspaceId] = status;
        }
        return workspaces;
      })()
    : await buildIngressStatusMap(
        ctx,
        pageIds,
        providerFilter || undefined,
        nonZeroOnly,
      );
  const alertCandidates = includeAlerts
    ? buildIngressAlerts(resolvedWorkspaces, thresholds)
    : [];
  const alertTotals = summarizeAlerts(alertCandidates);
  const alerts = alertCandidates.slice(0, maxAlerts);

  return ctx.json({
    generatedAt: new Date().toISOString(),
    alertProfile,
    effectiveAlertProfile: alertProfile,
    workspaceCount: totalWorkspaceCount,
    returnedWorkspaceCount: includeWorkspaces
      ? Object.keys(resolvedWorkspaces).length
      : pageIds.length,
    workspaceIds: includeWorkspaces ? Object.keys(resolvedWorkspaces) : pageIds,
    nextCursor,
    pendingTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.pendingTotal),
    ),
    deadLetterTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.deadLetterTotal),
    ),
    acceptedTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.acceptedTotal),
    ),
    droppedTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.droppedTotal),
    ),
    dedupedTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.dedupedTotal),
    ),
    coalescedTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.coalescedTotal),
    ),
    suppressedTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.suppressedTotal),
    ),
    staleTotal: sumNumber(
      Object.values(resolvedWorkspaces).map((item) => item.staleTotal),
    ),
    thresholds,
    alertTotals,
    alertsTruncated: alertCandidates.length > alerts.length,
    alerts,
    workspaces: includeWorkspaces ? resolvedWorkspaces : {},
  } satisfies IngressStatusMapResponse);
}

export async function handleAdminSync(
  ctx: AdminHandlerContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const providerFilter = normalizeProvider(
    url.searchParams.get("provider") ?? undefined,
  );
  const includeWorkspaces = parseBoolean(
    url.searchParams.get("includeWorkspaces"),
    true,
  );
  const includeAlerts = parseBoolean(
    url.searchParams.get("includeAlerts"),
    true,
  );
  const nonZeroOnly = parseBoolean(url.searchParams.get("nonZeroOnly"), false);
  const maxAlerts = clampInt(url.searchParams.get("maxAlerts"), 200, 0, 10_000);
  const limit = clampInt(url.searchParams.get("limit"), 200, 1, 5_000);
  const cursor = url.searchParams.get("cursor");
  const workspaceFilter = url.searchParams.get("workspaceId")?.trim() ?? "";
  const thresholds = {
    statusError: clampInt(
      url.searchParams.get("statusErrorThreshold"),
      1,
      1,
      1_000_000,
    ),
    lagSeconds: clampInt(
      url.searchParams.get("lagSecondsThreshold"),
      30,
      1,
      1_000_000,
    ),
    deadLetteredEnvelopes: clampInt(
      url.searchParams.get("deadLetteredEnvelopesThreshold"),
      1,
      1,
      1_000_000,
    ),
    deadLetteredOps: clampInt(
      url.searchParams.get("deadLetteredOpsThreshold"),
      1,
      1,
      1_000_000,
    ),
  };

  let workspaceIds = await listWorkspaceIds(ctx);
  if (workspaceFilter) {
    workspaceIds = workspaceIds.filter(
      (workspaceId) => workspaceId === workspaceFilter,
    );
  }
  workspaceIds.sort((left, right) => left.localeCompare(right));

  const totalWorkspaceCount = workspaceIds.length;
  if (cursor) {
    const index = workspaceIds.findIndex(
      (workspaceId) => workspaceId === cursor,
    );
    if (index >= 0) {
      workspaceIds = workspaceIds.slice(index + 1);
    }
  }

  const pageIds = workspaceIds.slice(0, limit);
  const nextCursor =
    workspaceIds.length > pageIds.length
      ? (pageIds[pageIds.length - 1] ?? null)
      : null;
  const workspaces: Record<string, SyncStatusResponse> = {};

  for (const workspaceId of pageIds) {
    const stats = await loadWorkspaceStats(ctx, workspaceId);
    const providers = await buildSyncProviders(
      ctx,
      workspaceId,
      stats.providerStatus,
      providerFilter || undefined,
    );
    if (nonZeroOnly && providers.length === 0) {
      continue;
    }
    if (includeWorkspaces) {
      workspaces[workspaceId] = { workspaceId, providers };
    }
  }

  const syncMap = includeWorkspaces
    ? workspaces
    : await buildSyncStatusMap(
        ctx,
        pageIds,
        providerFilter || undefined,
        nonZeroOnly,
      );
  const alertsAll = includeAlerts ? buildSyncAlerts(syncMap, thresholds) : [];
  const alertTotals = summarizeAlerts(alertsAll);
  const alerts = alertsAll.slice(0, maxAlerts);
  const providers = Object.values(syncMap).flatMap((item) => item.providers);

  const failureCodes: Record<string, number> = {};
  for (const provider of providers) {
    for (const [code, count] of Object.entries(provider.failureCodes ?? {})) {
      failureCodes[code] = (failureCodes[code] ?? 0) + count;
    }
  }

  return ctx.json({
    generatedAt: new Date().toISOString(),
    workspaceCount: totalWorkspaceCount,
    returnedWorkspaceCount: Object.keys(syncMap).length,
    workspaceIds: Object.keys(syncMap),
    nextCursor,
    providerStatusCount: providers.length,
    healthyCount: providers.filter((item) => item.status === "healthy").length,
    laggingCount: providers.filter((item) => item.status === "lagging").length,
    errorCount: providers.filter((item) => item.status === "error").length,
    pausedCount: providers.filter((item) => item.status === "paused").length,
    deadLetteredEnvelopesTotal: sumNumber(
      providers.map((item) => item.deadLetteredEnvelopes ?? 0),
    ),
    deadLetteredOpsTotal: sumNumber(
      providers.map((item) => item.deadLetteredOps ?? 0),
    ),
    thresholds,
    alertTotals,
    alertsTruncated: alertsAll.length > alerts.length,
    alerts,
    failureCodes,
    workspaces: includeWorkspaces ? workspaces : {},
  } satisfies AdminSyncStatusMapResponse);
}

export async function handleAdminReplayEnvelope(
  ctx: AdminHandlerContext,
  request: Request,
  envelopeId: string,
): Promise<Response> {
  const row = await d1First<StoredEnvelopeRow>(
    ctx,
    `
      SELECT envelope_id, workspace_id, provider, delivery_id, received_at, correlation_id, headers_json, payload_json, status, replay_count, last_error
      FROM webhook_envelopes
      WHERE envelope_id = ?
    `,
    envelopeId,
  );
  if (!row) {
    return ctx.errorResponse(
      request,
      ctx.errors.notFound.status,
      ctx.errors.notFound.code,
      ctx.errors.notFound.message,
    );
  }

  const authWorkspaceId = request.headers.get("X-Auth-Workspace-Id")?.trim();
  if (!authWorkspaceId) {
    return ctx.errorResponse(
      request,
      403,
      "forbidden",
      "missing workspace authentication",
    );
  }
  if (asString(row.workspace_id) !== authWorkspaceId) {
    return ctx.errorResponse(
      request,
      403,
      "forbidden",
      "envelope does not belong to authenticated workspace",
    );
  }

  const envelope = storedEnvelopeToMessage(row);
  await ctx.bindings.ENVELOPE_QUEUE.send(envelope);
  await d1Run(
    ctx,
    `
      UPDATE webhook_envelopes
      SET status = 'replayed',
          replay_count = replay_count + 1,
          updated_at = ?
      WHERE envelope_id = ?
    `,
    new Date().toISOString(),
    envelopeId,
  );

  return ctx.json(
    {
      status: "queued",
      id: envelopeId,
      correlationId: ctx.correlationId(request),
    } satisfies QueuedResponse,
    202,
  );
}

export async function handleAdminReplayOperation(
  ctx: AdminHandlerContext,
  request: Request,
  opId: string,
): Promise<Response> {
  const row = await d1First<Row>(
    ctx,
    `
      SELECT workspace_id, status
      FROM workspace_operations
      WHERE op_id = ?
    `,
    opId,
  );
  if (!row) {
    return ctx.errorResponse(
      request,
      ctx.errors.notFound.status,
      ctx.errors.notFound.code,
      ctx.errors.notFound.message,
    );
  }

  const authWorkspaceId = request.headers.get("X-Auth-Workspace-Id")?.trim();
  if (!authWorkspaceId) {
    return ctx.errorResponse(
      request,
      403,
      "forbidden",
      "missing workspace authentication",
    );
  }
  if (asString(row.workspace_id) !== authWorkspaceId) {
    return ctx.errorResponse(
      request,
      403,
      "forbidden",
      "operation does not belong to authenticated workspace",
    );
  }

  const status = asString(row.status);
  if (!isReplayableOperationStatus(status)) {
    return ctx.errorResponse(
      request,
      ctx.errors.invalidState.status,
      ctx.errors.invalidState.code,
      "operation is not replayable",
    );
  }

  const workspaceId = asString(row.workspace_id);
  const id = ctx.bindings.WORKSPACE_DO.idFromName(workspaceId);
  const stub = ctx.bindings.WORKSPACE_DO.get(id);
  return fetchWorkspaceDOWithBackpressure(
    stub,
    new Request("https://do/internal/replay-operation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": workspaceId,
        "X-Correlation-Id": ctx.correlationId(request),
      },
      body: JSON.stringify({ workspaceId, opId }),
    }),
    { reason: "durable_object_overloaded" },
  );
}

function normalizeProvider(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "";
}

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function clampFloat(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (!value?.trim()) {
    return fallback;
  }
  return value === "true" || value === "1";
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function sumNumber(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function summarizeAlerts(
  alerts: Array<{ severity: "warning" | "critical"; type: string }>,
) {
  const byType: Record<string, number> = {};
  let critical = 0;
  let warning = 0;
  for (const alert of alerts) {
    byType[alert.type] = (byType[alert.type] ?? 0) + 1;
    if (alert.severity === "critical") {
      critical += 1;
    } else {
      warning += 1;
    }
  }
  return {
    total: alerts.length,
    critical,
    warning,
    byType,
  };
}

function defaultPendingThreshold(
  profile: IngressStatusMapResponse["alertProfile"],
): number {
  switch (profile) {
    case "strict":
      return 25;
    case "relaxed":
      return 250;
    default:
      return 100;
  }
}

function defaultDeadLetterThreshold(
  profile: IngressStatusMapResponse["alertProfile"],
): number {
  return profile === "relaxed" ? 5 : 1;
}

function defaultStaleThreshold(
  profile: IngressStatusMapResponse["alertProfile"],
): number {
  switch (profile) {
    case "strict":
      return 3;
    case "relaxed":
      return 25;
    default:
      return 10;
  }
}

function defaultDropRateThreshold(
  profile: IngressStatusMapResponse["alertProfile"],
): number {
  switch (profile) {
    case "strict":
      return 0.01;
    case "relaxed":
      return 0.1;
    default:
      return 0.05;
  }
}

function buildIngressAlerts(
  workspaces: Record<string, IngressStatusResponse>,
  thresholds: IngressStatusMapResponse["thresholds"],
): IngressStatusMapResponse["alerts"] {
  const alerts: IngressStatusMapResponse["alerts"] = [];
  for (const [workspaceId, status] of Object.entries(workspaces)) {
    if (status.deadLetterTotal >= thresholds.deadLetter) {
      alerts.push({
        workspaceId,
        type: "dead_letters",
        severity:
          status.deadLetterTotal >= thresholds.deadLetter * 5
            ? "critical"
            : "warning",
        value: status.deadLetterTotal,
        threshold: thresholds.deadLetter,
        message: `Workspace ${workspaceId} has ${status.deadLetterTotal} dead letters`,
      });
    }
    if (status.pendingTotal >= thresholds.pending) {
      alerts.push({
        workspaceId,
        type: "pending_backlog",
        severity:
          status.pendingTotal >= thresholds.pending * 2
            ? "critical"
            : "warning",
        value: status.pendingTotal,
        threshold: thresholds.pending,
        message: `Workspace ${workspaceId} has ${status.pendingTotal} pending ingress items`,
      });
    }
    const dropRate = ratio(status.droppedTotal, status.acceptedTotal);
    if (dropRate >= thresholds.dropRate) {
      alerts.push({
        workspaceId,
        type: "drop_rate",
        severity:
          dropRate >= Math.max(thresholds.dropRate * 2, 0.5)
            ? "critical"
            : "warning",
        value: dropRate,
        threshold: thresholds.dropRate,
        message: `Workspace ${workspaceId} drop rate is ${(dropRate * 100).toFixed(1)}%`,
      });
    }
    if (status.staleTotal >= thresholds.stale) {
      alerts.push({
        workspaceId,
        type: "stale_events",
        severity:
          status.staleTotal >= thresholds.stale * 2 ? "critical" : "warning",
        value: status.staleTotal,
        threshold: thresholds.stale,
        message: `Workspace ${workspaceId} has ${status.staleTotal} stale events`,
      });
    }
  }
  return alerts;
}

function buildSyncAlerts(
  workspaces: Record<string, SyncStatusResponse>,
  thresholds: AdminSyncStatusMapResponse["thresholds"],
): AdminSyncStatusMapResponse["alerts"] {
  const alerts: AdminSyncStatusMapResponse["alerts"] = [];
  for (const [workspaceId, status] of Object.entries(workspaces)) {
    for (const provider of status.providers) {
      if (provider.status === "error") {
        alerts.push({
          workspaceId,
          provider: provider.provider,
          type: "status_error",
          severity: "critical",
          value: 1,
          threshold: thresholds.statusError,
          message: `Workspace ${workspaceId} provider ${provider.provider} is in error state`,
        });
      }
      if ((provider.lagSeconds ?? 0) >= thresholds.lagSeconds) {
        alerts.push({
          workspaceId,
          provider: provider.provider,
          type: "lag_seconds",
          severity:
            (provider.lagSeconds ?? 0) >= thresholds.lagSeconds * 2
              ? "critical"
              : "warning",
          value: provider.lagSeconds ?? 0,
          threshold: thresholds.lagSeconds,
          message: `Workspace ${workspaceId} provider ${provider.provider} lag is ${provider.lagSeconds ?? 0}s`,
        });
      }
      if (
        (provider.deadLetteredEnvelopes ?? 0) >=
        thresholds.deadLetteredEnvelopes
      ) {
        alerts.push({
          workspaceId,
          provider: provider.provider,
          type: "dead_lettered_envelopes",
          severity:
            (provider.deadLetteredEnvelopes ?? 0) >=
            thresholds.deadLetteredEnvelopes * 2
              ? "critical"
              : "warning",
          value: provider.deadLetteredEnvelopes ?? 0,
          threshold: thresholds.deadLetteredEnvelopes,
          message: `Workspace ${workspaceId} provider ${provider.provider} has ${provider.deadLetteredEnvelopes ?? 0} dead-lettered envelopes`,
        });
      }
      if ((provider.deadLetteredOps ?? 0) >= thresholds.deadLetteredOps) {
        alerts.push({
          workspaceId,
          provider: provider.provider,
          type: "dead_lettered_ops",
          severity:
            (provider.deadLetteredOps ?? 0) >= thresholds.deadLetteredOps * 2
              ? "critical"
              : "warning",
          value: provider.deadLetteredOps ?? 0,
          threshold: thresholds.deadLetteredOps,
          message: `Workspace ${workspaceId} provider ${provider.provider} has ${provider.deadLetteredOps ?? 0} dead-lettered writebacks`,
        });
      }
    }
  }
  return alerts;
}
