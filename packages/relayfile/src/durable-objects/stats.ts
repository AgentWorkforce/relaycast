import type { SyncStatusResponse } from "@relayfile/sdk";
import type {
  IngressStatusResponse,
  ProviderIngressStatus,
  SyncProviderStatus,
} from "../types.js";
import { asNumber, asOptionalString, asString, type Row } from "./d1.js";

export interface WorkspaceStatsMetadata {
  ingress?: {
    acceptedTotal: number;
    droppedTotal: number;
    dedupedTotal: number;
    coalescedTotal: number;
    pendingTotal: number;
    oldestPendingSince?: string | null;
    suppressedTotal: number;
    staleTotal: number;
    providers: Record<
      string,
      ProviderIngressStatus & { oldestPendingSince?: string | null }
    >;
  };
}

export interface WorkspaceStatsState {
  workspaceId: string;
  fileCount: number;
  directoryCount: number;
  bytesStored: number;
  operationCount: number;
  deadLetterCount: number;
  lastIngestedAt: string | null;
  lastEventAt: string | null;
  lastWritebackAt: string | null;
  lastActivity: string | null;
  providerStatus: Record<string, SyncProviderStatus>;
  metadata: WorkspaceStatsMetadata;
}

export interface WorkspaceStatsContext {
  d1Run(query: string, ...bindings: unknown[]): Promise<void>;
  d1First<T extends Row>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T | null>;
  d1All<T extends Row>(query: string, ...bindings: unknown[]): Promise<T[]>;
  all<T extends Row>(query: string, ...bindings: unknown[]): T[];
  ingressQueueCapacity: number;
}

export async function ensureWorkspaceStats(
  ctx: Pick<WorkspaceStatsContext, "d1Run">,
  workspaceId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await ctx.d1Run(
    `
      INSERT INTO workspace_stats (
        workspace_id,
        file_count,
        directory_count,
        bytes_stored,
        operation_count,
        dead_letter_count,
        last_ingested_at,
        last_event_at,
        last_writeback_at,
        last_activity,
        provider_status_json,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, '{}', '{}', ?, ?)
      ON CONFLICT(workspace_id) DO NOTHING
    `,
    workspaceId,
    now,
    now,
    now,
  );
}

export async function loadWorkspaceStats(
  ctx: Pick<WorkspaceStatsContext, "d1First" | "d1Run">,
  workspaceId: string,
): Promise<WorkspaceStatsState> {
  await ensureWorkspaceStats(ctx, workspaceId);

  const row = await ctx.d1First<Row>(
    `
      SELECT workspace_id, file_count, directory_count, bytes_stored, operation_count, dead_letter_count,
             last_ingested_at, last_event_at, last_writeback_at, last_activity,
             provider_status_json, metadata_json
      FROM workspace_stats
      WHERE workspace_id = ?
    `,
    workspaceId,
  );

  return {
    workspaceId,
    fileCount: asNumber(row?.file_count),
    directoryCount: asNumber(row?.directory_count),
    bytesStored: asNumber(row?.bytes_stored),
    operationCount: asNumber(row?.operation_count),
    deadLetterCount: asNumber(row?.dead_letter_count),
    lastIngestedAt: asOptionalString(row?.last_ingested_at) ?? null,
    lastEventAt: asOptionalString(row?.last_event_at) ?? null,
    lastWritebackAt: asOptionalString(row?.last_writeback_at) ?? null,
    lastActivity: asOptionalString(row?.last_activity) ?? null,
    providerStatus: parseProviderStatusMap(
      asOptionalString(row?.provider_status_json),
    ),
    metadata: parseWorkspaceStatsMetadata(asOptionalString(row?.metadata_json)),
  };
}

export async function saveWorkspaceStats(
  ctx: Pick<WorkspaceStatsContext, "d1Run">,
  state: WorkspaceStatsState,
): Promise<void> {
  await ctx.d1Run(
    `
      UPDATE workspace_stats
      SET file_count = ?,
          directory_count = ?,
          bytes_stored = ?,
          operation_count = ?,
          dead_letter_count = ?,
          last_ingested_at = ?,
          last_event_at = ?,
          last_writeback_at = ?,
          last_activity = ?,
          provider_status_json = ?,
          metadata_json = ?,
          updated_at = ?
      WHERE workspace_id = ?
    `,
    state.fileCount,
    state.directoryCount,
    state.bytesStored,
    state.operationCount,
    state.deadLetterCount,
    state.lastIngestedAt,
    state.lastEventAt,
    state.lastWritebackAt,
    state.lastActivity,
    JSON.stringify(state.providerStatus),
    JSON.stringify(state.metadata),
    new Date().toISOString(),
    state.workspaceId,
  );
}

export async function syncWorkspaceStats(
  ctx: WorkspaceStatsContext & Pick<WorkspaceStatsContext, "d1Run" | "d1First">,
  workspaceId: string,
  overrides?: Partial<
    Pick<
      WorkspaceStatsState,
      "lastIngestedAt" | "lastEventAt" | "lastWritebackAt" | "lastActivity"
    >
  >,
): Promise<void> {
  const files = ctx.all<Row>(`
    -- ALLOW UNBOUNDED: workspace stats rollup intentionally scans full table
    SELECT path, size FROM files ORDER BY path ASC
  `);
  const operations = ctx.all<Row>(`
    -- ALLOW UNBOUNDED: workspace stats rollup intentionally scans full table
    SELECT op_id FROM operations
  `);
  const directorySet = new Set<string>();
  let bytesStored = 0;

  for (const file of files) {
    bytesStored += asNumber(file.size);
    const path = normalizePath(asString(file.path));
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current += `/${parts[index]}`;
      directorySet.add(current);
    }
  }

  const deadLetterRow = await ctx.d1First<Row>(
    "SELECT COUNT(*) AS count FROM dead_letters WHERE workspace_id = ?",
    workspaceId,
  );
  const current = await loadWorkspaceStats(ctx, workspaceId);
  const next: WorkspaceStatsState = {
    ...current,
    fileCount: files.length,
    directoryCount: directorySet.size,
    bytesStored,
    operationCount: operations.length,
    deadLetterCount: asNumber(deadLetterRow?.count),
    lastIngestedAt: overrides?.lastIngestedAt ?? current.lastIngestedAt,
    lastEventAt: overrides?.lastEventAt ?? current.lastEventAt,
    lastWritebackAt: overrides?.lastWritebackAt ?? current.lastWritebackAt,
    lastActivity: overrides?.lastActivity ?? current.lastActivity,
  };

  await saveWorkspaceStats(ctx, next);
}

export async function touchWorkspaceWriteStats(
  ctx: Pick<WorkspaceStatsContext, "d1Run">,
  workspaceId: string,
  overrides: Partial<
    Pick<
      WorkspaceStatsState,
      "lastIngestedAt" | "lastEventAt" | "lastWritebackAt" | "lastActivity"
    >
  > & {
    fileCountDelta?: number;
    bytesStoredDelta?: number;
    operationCountDelta?: number;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const fileCountDelta = overrides.fileCountDelta ?? 0;
  const bytesStoredDelta = overrides.bytesStoredDelta ?? 0;
  const operationCountDelta = overrides.operationCountDelta ?? 0;
  // directory_count is intentionally not delta-maintained on hot writes:
  // deletes can empty ancestor directories, and exact reconciliation requires
  // the full workspace walk kept in syncWorkspaceStats.
  await ctx.d1Run(
    `
      INSERT INTO workspace_stats (
        workspace_id,
        file_count,
        directory_count,
        bytes_stored,
        operation_count,
        dead_letter_count,
        last_ingested_at,
        last_event_at,
        last_writeback_at,
        last_activity,
        provider_status_json,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, 0, ?, ?, 0, ?, ?, ?, ?, '{}', '{}', ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        file_count = MAX(0, workspace_stats.file_count + excluded.file_count),
        bytes_stored = MAX(0, workspace_stats.bytes_stored + excluded.bytes_stored),
        operation_count = MAX(0, workspace_stats.operation_count + excluded.operation_count),
        last_ingested_at = COALESCE(excluded.last_ingested_at, workspace_stats.last_ingested_at),
        last_event_at = COALESCE(excluded.last_event_at, workspace_stats.last_event_at),
        last_writeback_at = COALESCE(excluded.last_writeback_at, workspace_stats.last_writeback_at),
        last_activity = COALESCE(excluded.last_activity, workspace_stats.last_activity),
        updated_at = excluded.updated_at
    `,
    workspaceId,
    fileCountDelta,
    bytesStoredDelta,
    operationCountDelta,
    overrides.lastIngestedAt ?? null,
    overrides.lastEventAt ?? null,
    overrides.lastWritebackAt ?? null,
    overrides.lastActivity ?? null,
    now,
    now,
  );
}

export async function touchWorkspaceActivity(
  ctx: Pick<WorkspaceStatsContext, "d1Run">,
  workspaceId: string,
  touchedAt = new Date().toISOString(),
): Promise<void> {
  await ctx.d1Run(
    `
      INSERT INTO workspace_stats (
        workspace_id,
        file_count,
        directory_count,
        bytes_stored,
        operation_count,
        dead_letter_count,
        last_ingested_at,
        last_event_at,
        last_writeback_at,
        last_activity,
        provider_status_json,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (?, 0, 0, 0, 0, 0, NULL, NULL, NULL, ?, '{}', '{}', ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        last_activity = excluded.last_activity,
        updated_at = excluded.updated_at
    `,
    workspaceId,
    touchedAt,
    touchedAt,
    touchedAt,
  );
}

export async function bumpIngressMetric(
  ctx: Pick<WorkspaceStatsContext, "d1Run" | "d1First">,
  workspaceId: string,
  provider: string,
  update: (
    current: NonNullable<WorkspaceStatsMetadata["ingress"]>,
  ) => NonNullable<WorkspaceStatsMetadata["ingress"]>,
  lastIngestedAt?: string,
): Promise<void> {
  const stats = await loadWorkspaceStats(ctx, workspaceId);
  const ingress = update(stats.metadata.ingress ?? defaultIngressMetadata());
  const providerState =
    ingress.providers[provider] ?? defaultProviderIngressStatus();
  ingress.providers[provider] = providerState;
  stats.metadata.ingress = ingress;
  if (lastIngestedAt) {
    stats.lastIngestedAt = lastIngestedAt;
  }
  await saveWorkspaceStats(ctx, stats);
}

export async function updateProviderStatus(
  ctx: Pick<WorkspaceStatsContext, "d1Run" | "d1First">,
  workspaceId: string,
  provider: string,
  updater: (current: SyncProviderStatus) => SyncProviderStatus,
): Promise<void> {
  const stats = await loadWorkspaceStats(ctx, workspaceId);
  const current = stats.providerStatus[provider] ?? {
    provider,
    status: "healthy" as const,
  };
  stats.providerStatus[provider] = updater(current);
  await saveWorkspaceStats(ctx, stats);
}

export async function buildSyncProviders(
  ctx: Pick<WorkspaceStatsContext, "d1All" | "d1First" | "d1Run">,
  workspaceId: string,
  providerStatus: Record<string, SyncProviderStatus>,
  providerFilter?: string,
): Promise<SyncProviderStatus[]> {
  const normalizedProvider = normalizeProvider(providerFilter);
  const deadLetters = await ctx.d1All<Row>(
    `
      SELECT provider, COUNT(*) AS count
      FROM dead_letters
      WHERE workspace_id = ?
      GROUP BY provider
    `,
    workspaceId,
  );
  const deadLetteredOps = await ctx.d1All<Row>(
    `
      SELECT provider, COUNT(*) AS count
      FROM workspace_operations
      WHERE workspace_id = ? AND status = 'dead_lettered'
      GROUP BY provider
    `,
    workspaceId,
  );

  const deadLetterMap = new Map(
    deadLetters.map((row) => [
      normalizeProvider(asString(row.provider)),
      asNumber(row.count),
    ]),
  );
  const deadLetterOpsMap = new Map(
    deadLetteredOps.map((row) => [
      normalizeProvider(asString(row.provider)),
      asNumber(row.count),
    ]),
  );
  const providerNames = new Set<string>([
    ...Object.keys(providerStatus),
    ...deadLetterMap.keys(),
    ...deadLetterOpsMap.keys(),
  ]);

  return Array.from(providerNames)
    .filter(Boolean)
    .filter(
      (provider) => !normalizedProvider || provider === normalizedProvider,
    )
    .sort((left, right) => left.localeCompare(right))
    .map((provider) => {
      const current = providerStatus[provider] ?? {
        provider,
        status: "healthy" as const,
      };
      return {
        ...current,
        provider,
        deadLetteredEnvelopes:
          deadLetterMap.get(provider) ?? current.deadLetteredEnvelopes ?? 0,
        deadLetteredOps:
          deadLetterOpsMap.get(provider) ?? current.deadLetteredOps ?? 0,
      };
    });
}

export async function buildIngressStatus(
  ctx: WorkspaceStatsContext &
    Pick<WorkspaceStatsContext, "d1Run" | "d1First" | "d1All">,
  workspaceId: string,
  providerFilter?: string,
): Promise<IngressStatusResponse> {
  const stats = await loadWorkspaceStats(ctx, workspaceId);
  const ingress = stats.metadata.ingress ?? defaultIngressMetadata();
  const provider = normalizeProvider(providerFilter);

  const deadLetters = await ctx.d1All<Row>(
    `
      SELECT provider, COUNT(*) AS count
      FROM dead_letters
      WHERE workspace_id = ?
      GROUP BY provider
    `,
    workspaceId,
  );

  const deadLetterByProvider: Record<string, number> = {};
  for (const row of deadLetters) {
    const key = normalizeProvider(asString(row.provider));
    if (!provider || key === provider) {
      deadLetterByProvider[key] = asNumber(row.count);
    }
  }

  const providers = Object.entries(ingress.providers)
    .filter(([key]) => !provider || key === provider)
    .reduce<Record<string, ProviderIngressStatus>>((acc, [key, value]) => {
      acc[key] = stripProviderPendingSince(value);
      return acc;
    }, {});

  const total = summarizeIngress(ingress, provider || undefined);
  const pendingSinceValues = Object.entries(ingress.providers)
    .filter(([key]) => !provider || key === provider)
    .map(([, value]) => value.oldestPendingSince)
    .filter(Boolean) as string[];
  const oldestPendingSince =
    pendingSinceValues.sort()[0] ?? ingress.oldestPendingSince ?? null;
  const queueDepth = total.pendingTotal;

  return {
    workspaceId,
    queueDepth,
    queueCapacity: ctx.ingressQueueCapacity,
    queueUtilization: ratio(queueDepth, ctx.ingressQueueCapacity),
    pendingTotal: total.pendingTotal,
    oldestPendingAgeSeconds: oldestPendingSince
      ? ageSeconds(oldestPendingSince)
      : 0,
    deadLetterTotal: sumNumber(Object.values(deadLetterByProvider)),
    deadLetterByProvider,
    acceptedTotal: total.acceptedTotal,
    droppedTotal: total.droppedTotal,
    dedupedTotal: total.dedupedTotal,
    coalescedTotal: total.coalescedTotal,
    dedupeRate: ratio(total.dedupedTotal, total.acceptedTotal),
    coalesceRate: ratio(total.coalescedTotal, total.acceptedTotal),
    suppressedTotal: total.suppressedTotal,
    staleTotal: total.staleTotal,
    ingressByProvider: providers,
  };
}

export async function buildIngressStatusMap(
  ctx: WorkspaceStatsContext &
    Pick<WorkspaceStatsContext, "d1Run" | "d1First" | "d1All">,
  workspaceIds: string[],
  providerFilter?: string,
  nonZeroOnly = false,
): Promise<Record<string, IngressStatusResponse>> {
  const map: Record<string, IngressStatusResponse> = {};
  for (const workspaceId of workspaceIds) {
    const status = await buildIngressStatus(ctx, workspaceId, providerFilter);
    if (nonZeroOnly && isZeroIngressStatus(status)) {
      continue;
    }
    map[workspaceId] = status;
  }
  return map;
}

export async function buildSyncStatusMap(
  ctx: Pick<WorkspaceStatsContext, "d1Run" | "d1First" | "d1All">,
  workspaceIds: string[],
  providerFilter?: string,
  nonZeroOnly = false,
): Promise<Record<string, SyncStatusResponse>> {
  const map: Record<string, SyncStatusResponse> = {};
  for (const workspaceId of workspaceIds) {
    const stats = await loadWorkspaceStats(ctx, workspaceId);
    const providers = await buildSyncProviders(
      ctx,
      workspaceId,
      stats.providerStatus,
      providerFilter,
    );
    if (nonZeroOnly && providers.length === 0) {
      continue;
    }
    map[workspaceId] = { workspaceId, providers };
  }
  return map;
}

export async function listWorkspaceIds(
  ctx: Pick<WorkspaceStatsContext, "d1All">,
): Promise<string[]> {
  const rows = await ctx.d1All<Row>(
    `
      SELECT workspace_id
      FROM workspace_stats
      ORDER BY workspace_id ASC
    `,
  );
  return rows.map((row) => asString(row.workspace_id)).filter(Boolean);
}

export function parseProviderStatusMap(
  raw?: string | null,
): Record<string, SyncProviderStatus> {
  const parsed = parseJsonRecord(raw ?? undefined);
  if (!parsed) {
    return {};
  }
  const out: Record<string, SyncProviderStatus> = {};
  for (const [provider, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      out[provider] = {
        provider,
        status: (typeof record.status === "string"
          ? record.status
          : "healthy") as SyncProviderStatus["status"],
        cursor: asOptionalString(record.cursor) ?? null,
        watermarkTs: asOptionalString(record.watermarkTs) ?? null,
        lagSeconds:
          typeof record.lagSeconds === "number"
            ? record.lagSeconds
            : asNumber(record.lagSeconds),
        lastError: asOptionalString(record.lastError) ?? null,
        failureCodes: parseNumberMap(record.failureCodes),
        deadLetteredEnvelopes: asNumber(record.deadLetteredEnvelopes),
        deadLetteredOps: asNumber(record.deadLetteredOps),
        webhookHealthy:
          typeof record.webhookHealthy === "boolean"
            ? record.webhookHealthy
            : undefined,
        webhookLastEventAt: asOptionalString(record.webhookLastEventAt) ?? null,
        webhookLastError: asOptionalString(record.webhookLastError) ?? null,
      };
    }
  }
  return out;
}

export function parseWorkspaceStatsMetadata(
  raw?: string | null,
): WorkspaceStatsMetadata {
  const parsed = parseJsonRecord(raw ?? undefined);
  if (!parsed) {
    return { ingress: defaultIngressMetadata() };
  }

  const ingressRecord =
    parsed.ingress &&
    typeof parsed.ingress === "object" &&
    !Array.isArray(parsed.ingress)
      ? (parsed.ingress as Record<string, unknown>)
      : null;
  if (!ingressRecord) {
    return { ingress: defaultIngressMetadata() };
  }

  const providersRecord =
    ingressRecord.providers &&
    typeof ingressRecord.providers === "object" &&
    !Array.isArray(ingressRecord.providers)
      ? (ingressRecord.providers as Record<string, unknown>)
      : {};
  const providers: Record<
    string,
    ProviderIngressStatus & { oldestPendingSince?: string | null }
  > = {};

  for (const [provider, value] of Object.entries(providersRecord)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    providers[provider] = {
      acceptedTotal: asNumber(record.acceptedTotal),
      droppedTotal: asNumber(record.droppedTotal),
      dedupedTotal: asNumber(record.dedupedTotal),
      coalescedTotal: asNumber(record.coalescedTotal),
      pendingTotal: asNumber(record.pendingTotal),
      oldestPendingAgeSeconds: asNumber(record.oldestPendingAgeSeconds),
      suppressedTotal: asNumber(record.suppressedTotal),
      staleTotal: asNumber(record.staleTotal),
      dedupeRate: typeof record.dedupeRate === "number" ? record.dedupeRate : 0,
      coalesceRate:
        typeof record.coalesceRate === "number" ? record.coalesceRate : 0,
      oldestPendingSince: asOptionalString(record.oldestPendingSince) ?? null,
    };
  }

  return {
    ingress: {
      acceptedTotal: asNumber(ingressRecord.acceptedTotal),
      droppedTotal: asNumber(ingressRecord.droppedTotal),
      dedupedTotal: asNumber(ingressRecord.dedupedTotal),
      coalescedTotal: asNumber(ingressRecord.coalescedTotal),
      pendingTotal: asNumber(ingressRecord.pendingTotal),
      oldestPendingSince:
        asOptionalString(ingressRecord.oldestPendingSince) ?? null,
      suppressedTotal: asNumber(ingressRecord.suppressedTotal),
      staleTotal: asNumber(ingressRecord.staleTotal),
      providers,
    },
  };
}

export function defaultIngressMetadata(): NonNullable<
  WorkspaceStatsMetadata["ingress"]
> {
  return {
    acceptedTotal: 0,
    droppedTotal: 0,
    dedupedTotal: 0,
    coalescedTotal: 0,
    pendingTotal: 0,
    oldestPendingSince: null,
    suppressedTotal: 0,
    staleTotal: 0,
    providers: {},
  };
}

export function defaultProviderIngressStatus(): ProviderIngressStatus & {
  oldestPendingSince?: string | null;
} {
  return {
    acceptedTotal: 0,
    droppedTotal: 0,
    dedupedTotal: 0,
    coalescedTotal: 0,
    pendingTotal: 0,
    oldestPendingAgeSeconds: 0,
    suppressedTotal: 0,
    staleTotal: 0,
    dedupeRate: 0,
    coalesceRate: 0,
    oldestPendingSince: null,
  };
}

export function incrementIngressMetric(
  current: NonNullable<WorkspaceStatsMetadata["ingress"]>,
  provider: string,
  metric: "accepted" | "deduped" | "suppressed" | "stale",
  pendingSince?: string,
): NonNullable<WorkspaceStatsMetadata["ingress"]> {
  const next = cloneIngress(current);
  const providerState =
    next.providers[provider] ?? defaultProviderIngressStatus();
  next.providers[provider] = providerState;

  switch (metric) {
    case "accepted":
      next.acceptedTotal += 1;
      next.pendingTotal += 1;
      providerState.acceptedTotal += 1;
      providerState.pendingTotal += 1;
      providerState.oldestPendingSince =
        providerState.oldestPendingSince ??
        pendingSince ??
        new Date().toISOString();
      next.oldestPendingSince =
        next.oldestPendingSince ?? pendingSince ?? new Date().toISOString();
      break;
    case "deduped":
      next.dedupedTotal += 1;
      providerState.dedupedTotal += 1;
      break;
    case "suppressed":
      next.suppressedTotal += 1;
      providerState.suppressedTotal += 1;
      break;
    case "stale":
      next.staleTotal += 1;
      providerState.staleTotal += 1;
      break;
  }

  recomputeIngressRates(next, provider);
  return next;
}

export function decrementPending(
  current: NonNullable<WorkspaceStatsMetadata["ingress"]>,
  provider: string,
): NonNullable<WorkspaceStatsMetadata["ingress"]> {
  const next = cloneIngress(current);
  const providerState =
    next.providers[provider] ?? defaultProviderIngressStatus();
  next.providers[provider] = providerState;

  next.pendingTotal = Math.max(0, next.pendingTotal - 1);
  providerState.pendingTotal = Math.max(0, providerState.pendingTotal - 1);
  if (providerState.pendingTotal === 0) {
    providerState.oldestPendingSince = null;
  }
  if (next.pendingTotal === 0) {
    next.oldestPendingSince = null;
  }
  recomputeIngressRates(next, provider);
  return next;
}

export function stripProviderPendingSince(
  provider: ProviderIngressStatus & { oldestPendingSince?: string | null },
): ProviderIngressStatus {
  return {
    acceptedTotal: provider.acceptedTotal,
    droppedTotal: provider.droppedTotal,
    dedupedTotal: provider.dedupedTotal,
    coalescedTotal: provider.coalescedTotal,
    pendingTotal: provider.pendingTotal,
    oldestPendingAgeSeconds: provider.oldestPendingSince
      ? ageSeconds(provider.oldestPendingSince)
      : 0,
    suppressedTotal: provider.suppressedTotal,
    staleTotal: provider.staleTotal,
    dedupeRate: ratio(provider.dedupedTotal, provider.acceptedTotal),
    coalesceRate: ratio(provider.coalescedTotal, provider.acceptedTotal),
  };
}

export function summarizeIngress(
  ingress: NonNullable<WorkspaceStatsMetadata["ingress"]>,
  provider?: string,
): Omit<
  IngressStatusResponse,
  | "workspaceId"
  | "queueDepth"
  | "queueCapacity"
  | "queueUtilization"
  | "oldestPendingAgeSeconds"
  | "deadLetterTotal"
  | "deadLetterByProvider"
  | "ingressByProvider"
> {
  if (!provider) {
    return {
      acceptedTotal: ingress.acceptedTotal,
      droppedTotal: ingress.droppedTotal,
      dedupedTotal: ingress.dedupedTotal,
      coalescedTotal: ingress.coalescedTotal,
      pendingTotal: ingress.pendingTotal,
      dedupeRate: ratio(ingress.dedupedTotal, ingress.acceptedTotal),
      coalesceRate: ratio(ingress.coalescedTotal, ingress.acceptedTotal),
      suppressedTotal: ingress.suppressedTotal,
      staleTotal: ingress.staleTotal,
    };
  }
  const item = ingress.providers[provider] ?? defaultProviderIngressStatus();
  return {
    acceptedTotal: item.acceptedTotal,
    droppedTotal: item.droppedTotal,
    dedupedTotal: item.dedupedTotal,
    coalescedTotal: item.coalescedTotal,
    pendingTotal: item.pendingTotal,
    dedupeRate: ratio(item.dedupedTotal, item.acceptedTotal),
    coalesceRate: ratio(item.coalescedTotal, item.acceptedTotal),
    suppressedTotal: item.suppressedTotal,
    staleTotal: item.staleTotal,
  };
}

export function isZeroIngressStatus(status: IngressStatusResponse): boolean {
  return (
    status.pendingTotal === 0 &&
    status.deadLetterTotal === 0 &&
    status.acceptedTotal === 0 &&
    status.droppedTotal === 0 &&
    status.dedupedTotal === 0 &&
    status.coalescedTotal === 0 &&
    status.suppressedTotal === 0 &&
    status.staleTotal === 0
  );
}

function parseJsonRecord(raw?: string): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

function parseNumberMap(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = asNumber(entry);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}

function normalizeProvider(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "";
}

function cloneIngress(
  current: NonNullable<WorkspaceStatsMetadata["ingress"]>,
): NonNullable<WorkspaceStatsMetadata["ingress"]> {
  return {
    ...current,
    providers: Object.fromEntries(
      Object.entries(current.providers).map(([provider, status]) => [
        provider,
        { ...status },
      ]),
    ),
  };
}

function recomputeIngressRates(
  current: NonNullable<WorkspaceStatsMetadata["ingress"]>,
  provider: string,
): void {
  current.providers[provider].dedupeRate = ratio(
    current.providers[provider].dedupedTotal,
    current.providers[provider].acceptedTotal,
  );
  current.providers[provider].coalesceRate = ratio(
    current.providers[provider].coalescedTotal,
    current.providers[provider].acceptedTotal,
  );
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function ageSeconds(isoTimestamp: string): number {
  const ms = Date.now() - Date.parse(isoTimestamp);
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}

function sumNumber(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
