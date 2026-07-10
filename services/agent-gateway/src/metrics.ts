type MetricCounterEntry = {
  ts: string;
  agentId: string;
  eventType: string;
};

type MetricDurationEntry = MetricCounterEntry & {
  durationMs: number;
};

type MetricCostEntry = MetricCounterEntry & {
  costUsd: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type WorkspaceMetricsState = {
  received: MetricCounterEntry[];
  retries: MetricCounterEntry[];
  drops: MetricCounterEntry[];
  durations: MetricDurationEntry[];
  costs: MetricCostEntry[];
};

export type MetricSummary = {
  eventsReceivedTotal: number;
  retriesTotal: number;
  dropsTotal: number;
  retryRate: number;
  dropRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
};

export type MetricSeries = {
  eventsPerMinute: number[];
  eventsPerMinuteByType: Record<string, number[]>;
  retryRate: number[];
  dropRate: number[];
  latencyP50Ms: number[];
  latencyP95Ms: number[];
  latencyP99Ms: number[];
  costUsdPerMinute: number[];
  costUsdPerMinuteByEventType: Record<string, number[]>;
};

export type CostByEventType = {
  eventType: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sampleCount: number;
};

export type EventTypeMetrics = {
  eventType: string;
  summary: MetricSummary;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type AgentMetricsSnapshot = {
  agentId: string;
  summary: MetricSummary;
  series: MetricSeries;
  byEventType: EventTypeMetrics[];
  costByEventType: CostByEventType[];
};

export type WorkspaceMetricsSnapshot = {
  workspace: string;
  generatedAt: string;
  windowMinutes: number;
  selectedAgentId?: string;
  totals: MetricSummary;
  series: MetricSeries;
  agents: AgentMetricsSnapshot[];
  costByEventType: CostByEventType[];
};

type MetricCollection = {
  received: MetricCounterEntry[];
  retries: MetricCounterEntry[];
  drops: MetricCounterEntry[];
  durations: MetricDurationEntry[];
  costs: MetricCostEntry[];
};

const METRICS_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_COUNTER_ENTRIES = 20_000;
const MAX_DURATION_ENTRIES = 20_000;
const MAX_COST_ENTRIES = 10_000;

export function createEmptyMetricsState(): WorkspaceMetricsState {
  return {
    received: [],
    retries: [],
    drops: [],
    durations: [],
    costs: [],
  };
}

export function ensureMetricsState<T extends { metrics?: WorkspaceMetricsState }>(
  state: T,
): WorkspaceMetricsState {
  const metrics = state.metrics ?? createEmptyMetricsState();
  state.metrics = metrics;
  pruneMetricsState(metrics);
  return metrics;
}

export function recordReceivedMetric(
  metrics: WorkspaceMetricsState,
  input: { agentId: string; eventType: string; ts?: string },
): void {
  metrics.received.push(buildCounterEntry(input));
  pruneEntries(metrics.received, MAX_COUNTER_ENTRIES, Date.now() - METRICS_RETENTION_MS);
}

export function recordRetryMetric(
  metrics: WorkspaceMetricsState,
  input: { agentId: string; eventType: string; ts?: string },
): void {
  metrics.retries.push(buildCounterEntry(input));
  pruneEntries(metrics.retries, MAX_COUNTER_ENTRIES, Date.now() - METRICS_RETENTION_MS);
}

export function recordDropMetric(
  metrics: WorkspaceMetricsState,
  input: { agentId: string; eventType: string; ts?: string },
): void {
  metrics.drops.push(buildCounterEntry(input));
  pruneEntries(metrics.drops, MAX_COUNTER_ENTRIES, Date.now() - METRICS_RETENTION_MS);
}

export function recordDurationMetric(
  metrics: WorkspaceMetricsState,
  input: {
    agentId: string;
    eventType: string;
    durationMs: number;
    ts?: string;
  },
): void {
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    return;
  }

  metrics.durations.push({
    ...buildCounterEntry(input),
    durationMs: input.durationMs,
  });
  pruneEntries(metrics.durations, MAX_DURATION_ENTRIES, Date.now() - METRICS_RETENTION_MS);
}

export function recordCostMetric(
  metrics: WorkspaceMetricsState,
  input: {
    agentId: string;
    eventType: string;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    ts?: string;
  },
): void {
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) {
    return;
  }

  metrics.costs.push({
    ...buildCounterEntry(input),
    costUsd: input.costUsd,
    ...(Number.isFinite(input.inputTokens) ? { inputTokens: Math.max(0, Math.trunc(input.inputTokens!)) } : {}),
    ...(Number.isFinite(input.outputTokens) ? { outputTokens: Math.max(0, Math.trunc(input.outputTokens!)) } : {}),
  });
  pruneEntries(metrics.costs, MAX_COST_ENTRIES, Date.now() - METRICS_RETENTION_MS);
}

export function buildMetricsSnapshot(
  workspace: string,
  metrics: WorkspaceMetricsState | undefined,
  options?: {
    agentId?: string;
    nowMs?: number;
    windowMinutes?: number;
  },
): WorkspaceMetricsSnapshot {
  const state = metrics ?? createEmptyMetricsState();
  const nowMs = options?.nowMs ?? Date.now();
  const windowMinutes = clampWindowMinutes(options?.windowMinutes);
  const sinceMs = nowMs - windowMinutes * 60_000;
  const selectedAgentId = normalizeString(options?.agentId);
  const filtered = filterMetricsWindow(state, sinceMs, selectedAgentId);
  const totals = buildSummary(filtered);
  const series = buildSeries(filtered, sinceMs, windowMinutes);
  const costByEventType = aggregateCostByEventType(filtered.costs);

  const agentIds = collectAgentIds(filtered);
  const agents = agentIds
    .map((agentId) => buildAgentSnapshot(agentId, filtered, sinceMs, windowMinutes))
    .sort((left, right) => {
      const delta = right.summary.eventsReceivedTotal - left.summary.eventsReceivedTotal;
      return delta !== 0 ? delta : left.agentId.localeCompare(right.agentId);
    });

  return {
    workspace,
    generatedAt: new Date(nowMs).toISOString(),
    windowMinutes,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    totals,
    series,
    agents,
    costByEventType,
  };
}

export function pruneMetricsState(
  metrics: WorkspaceMetricsState,
  nowMs: number = Date.now(),
): void {
  const cutoffMs = nowMs - METRICS_RETENTION_MS;
  pruneEntries(metrics.received, MAX_COUNTER_ENTRIES, cutoffMs);
  pruneEntries(metrics.retries, MAX_COUNTER_ENTRIES, cutoffMs);
  pruneEntries(metrics.drops, MAX_COUNTER_ENTRIES, cutoffMs);
  pruneEntries(metrics.durations, MAX_DURATION_ENTRIES, cutoffMs);
  pruneEntries(metrics.costs, MAX_COST_ENTRIES, cutoffMs);
}

function buildAgentSnapshot(
  agentId: string,
  metrics: MetricCollection,
  sinceMs: number,
  windowMinutes: number,
): AgentMetricsSnapshot {
  const filtered = filterMetricsWindow(metrics, sinceMs, agentId, true);
  return {
    agentId,
    summary: buildSummary(filtered),
    series: buildSeries(filtered, sinceMs, windowMinutes),
    byEventType: buildEventTypeMetrics(filtered),
    costByEventType: aggregateCostByEventType(filtered.costs),
  };
}

function filterMetricsWindow(
  metrics: MetricCollection,
  sinceMs: number,
  agentId?: string,
  treatSinceAsAbsolute = false,
): MetricCollection {
  const cutoffMs = treatSinceAsAbsolute ? sinceMs : sinceMs;
  return {
    received: metrics.received.filter((entry) => matchesMetricEntry(entry, cutoffMs, agentId)),
    retries: metrics.retries.filter((entry) => matchesMetricEntry(entry, cutoffMs, agentId)),
    drops: metrics.drops.filter((entry) => matchesMetricEntry(entry, cutoffMs, agentId)),
    durations: metrics.durations.filter((entry) => matchesMetricEntry(entry, cutoffMs, agentId)),
    costs: metrics.costs.filter((entry) => matchesMetricEntry(entry, cutoffMs, agentId)),
  };
}

function matchesMetricEntry(
  entry: { ts: string; agentId: string },
  sinceMs: number,
  agentId?: string,
): boolean {
  const tsMs = Date.parse(entry.ts);
  if (!Number.isFinite(tsMs) || tsMs < sinceMs) {
    return false;
  }
  return !agentId || entry.agentId === agentId;
}

function buildSummary(metrics: MetricCollection): MetricSummary {
  const receivedTotal = metrics.received.length;
  const retriesTotal = metrics.retries.length;
  const dropsTotal = metrics.drops.length;
  const durations = metrics.durations.map((entry) => entry.durationMs);

  return {
    eventsReceivedTotal: receivedTotal,
    retriesTotal,
    dropsTotal,
    retryRate: receivedTotal > 0 ? retriesTotal / receivedTotal : 0,
    dropRate: receivedTotal > 0 ? dropsTotal / receivedTotal : 0,
    latencyP50Ms: percentile(durations, 0.5),
    latencyP95Ms: percentile(durations, 0.95),
    latencyP99Ms: percentile(durations, 0.99),
  };
}

function buildSeries(
  metrics: MetricCollection,
  sinceMs: number,
  windowMinutes: number,
): MetricSeries {
  const eventsPerMinute = buildCounterSeries(metrics.received, sinceMs, windowMinutes);
  const eventsPerMinuteByType = buildCounterSeriesByKey(
    metrics.received,
    sinceMs,
    windowMinutes,
    (entry) => entry.eventType,
  );
  const retriesPerMinute = buildCounterSeries(metrics.retries, sinceMs, windowMinutes);
  const dropsPerMinute = buildCounterSeries(metrics.drops, sinceMs, windowMinutes);
  const durationBuckets = buildDurationBuckets(metrics.durations, sinceMs, windowMinutes);
  const costUsdPerMinute = buildCostSeries(metrics.costs, sinceMs, windowMinutes);
  const costUsdPerMinuteByEventType = buildCostSeriesByKey(
    metrics.costs,
    sinceMs,
    windowMinutes,
    (entry) => entry.eventType,
  );

  return {
    eventsPerMinute,
    eventsPerMinuteByType,
    retryRate: eventsPerMinute.map((count, index) =>
      count > 0 ? retriesPerMinute[index]! / count : 0,
    ),
    dropRate: eventsPerMinute.map((count, index) =>
      count > 0 ? dropsPerMinute[index]! / count : 0,
    ),
    latencyP50Ms: durationBuckets.map((bucket) => percentile(bucket, 0.5)),
    latencyP95Ms: durationBuckets.map((bucket) => percentile(bucket, 0.95)),
    latencyP99Ms: durationBuckets.map((bucket) => percentile(bucket, 0.99)),
    costUsdPerMinute,
    costUsdPerMinuteByEventType,
  };
}

function buildEventTypeMetrics(metrics: MetricCollection): EventTypeMetrics[] {
  const eventTypes = collectEventTypes(metrics);
  return eventTypes
    .map((eventType) => {
      const received = metrics.received.filter((entry) => entry.eventType === eventType);
      const retries = metrics.retries.filter((entry) => entry.eventType === eventType);
      const drops = metrics.drops.filter((entry) => entry.eventType === eventType);
      const durations = metrics.durations.filter((entry) => entry.eventType === eventType);
      const costs = metrics.costs.filter((entry) => entry.eventType === eventType);
      const costSummary = summarizeCost(costs);

      return {
        eventType,
        summary: buildSummary({ received, retries, drops, durations, costs }),
        costUsd: costSummary.costUsd,
        inputTokens: costSummary.inputTokens,
        outputTokens: costSummary.outputTokens,
      };
    })
    .sort((left, right) => {
      const delta = right.summary.eventsReceivedTotal - left.summary.eventsReceivedTotal;
      return delta !== 0 ? delta : left.eventType.localeCompare(right.eventType);
    });
}

function aggregateCostByEventType(entries: MetricCostEntry[]): CostByEventType[] {
  const grouped = new Map<string, MetricCostEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.eventType) ?? [];
    bucket.push(entry);
    grouped.set(entry.eventType, bucket);
  }

  return [...grouped.entries()]
    .map(([eventType, groupedEntries]) => {
      const summary = summarizeCost(groupedEntries);
      return {
        eventType,
        costUsd: summary.costUsd,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        sampleCount: groupedEntries.length,
      };
    })
    .sort((left, right) => {
      const delta = right.costUsd - left.costUsd;
      return delta !== 0 ? delta : left.eventType.localeCompare(right.eventType);
    });
}

function summarizeCost(entries: MetricCostEntry[]): {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
} {
  return entries.reduce(
    (acc, entry) => ({
      costUsd: acc.costUsd + entry.costUsd,
      inputTokens: acc.inputTokens + (entry.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (entry.outputTokens ?? 0),
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
}

function buildCounterSeries(
  entries: Array<{ ts: string }>,
  sinceMs: number,
  windowMinutes: number,
): number[] {
  const buckets = Array.from({ length: windowMinutes }, () => 0);
  for (const entry of entries) {
    const index = bucketIndex(entry.ts, sinceMs, windowMinutes);
    if (index === null) {
      continue;
    }
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

function buildCounterSeriesByKey<TEntry extends { ts: string }>(
  entries: TEntry[],
  sinceMs: number,
  windowMinutes: number,
  getKey: (entry: TEntry) => string,
): Record<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const entry of entries) {
    const key = getKey(entry).trim();
    if (!key) {
      continue;
    }

    const index = bucketIndex(entry.ts, sinceMs, windowMinutes);
    if (index === null) {
      continue;
    }

    const series = buckets.get(key) ?? Array.from({ length: windowMinutes }, () => 0);
    series[index] = (series[index] ?? 0) + 1;
    buckets.set(key, series);
  }

  return Object.fromEntries(
    [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildCostSeries(
  entries: MetricCostEntry[],
  sinceMs: number,
  windowMinutes: number,
): number[] {
  const buckets = Array.from({ length: windowMinutes }, () => 0);
  for (const entry of entries) {
    const index = bucketIndex(entry.ts, sinceMs, windowMinutes);
    if (index === null) {
      continue;
    }

    buckets[index] = (buckets[index] ?? 0) + entry.costUsd;
  }
  return buckets;
}

function buildCostSeriesByKey<TEntry extends MetricCostEntry>(
  entries: TEntry[],
  sinceMs: number,
  windowMinutes: number,
  getKey: (entry: TEntry) => string,
): Record<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const entry of entries) {
    const key = getKey(entry).trim();
    if (!key) {
      continue;
    }

    const index = bucketIndex(entry.ts, sinceMs, windowMinutes);
    if (index === null) {
      continue;
    }

    const series = buckets.get(key) ?? Array.from({ length: windowMinutes }, () => 0);
    series[index] = (series[index] ?? 0) + entry.costUsd;
    buckets.set(key, series);
  }

  return Object.fromEntries(
    [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildDurationBuckets(
  entries: MetricDurationEntry[],
  sinceMs: number,
  windowMinutes: number,
): number[][] {
  const buckets = Array.from({ length: windowMinutes }, () => [] as number[]);
  for (const entry of entries) {
    const index = bucketIndex(entry.ts, sinceMs, windowMinutes);
    if (index === null) {
      continue;
    }
    buckets[index]?.push(entry.durationMs);
  }
  return buckets;
}

function bucketIndex(ts: string, sinceMs: number, windowMinutes: number): number | null {
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) {
    return null;
  }
  const deltaMs = tsMs - sinceMs;
  if (deltaMs < 0) {
    return null;
  }
  const index = Math.floor(deltaMs / 60_000);
  return index >= 0 && index < windowMinutes ? index : null;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(1, Math.max(0, ratio));
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * clamped) - 1),
  );

  return Math.round(sorted[index] ?? 0);
}

function collectAgentIds(metrics: MetricCollection): string[] {
  const ids = new Set<string>();
  for (const collection of [metrics.received, metrics.retries, metrics.drops, metrics.durations, metrics.costs]) {
    for (const entry of collection) {
      ids.add(entry.agentId);
    }
  }
  return [...ids].sort();
}

function collectEventTypes(metrics: MetricCollection): string[] {
  const eventTypes = new Set<string>();
  for (const collection of [metrics.received, metrics.retries, metrics.drops, metrics.durations, metrics.costs]) {
    for (const entry of collection) {
      eventTypes.add(entry.eventType);
    }
  }
  return [...eventTypes].sort();
}

function buildCounterEntry(input: {
  agentId: string;
  eventType: string;
  ts?: string;
}): MetricCounterEntry {
  return {
    ts: normalizeTimestamp(input.ts),
    agentId: normalizeString(input.agentId) ?? "unknown-agent",
    eventType: normalizeString(input.eventType) ?? "unknown.event",
  };
}

function normalizeTimestamp(value: string | undefined): string {
  const ts = value ? Date.parse(value) : Date.now();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function clampWindowMinutes(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 60;
  }

  return Math.min(24 * 60, Math.max(5, Math.trunc(value!)));
}

function pruneEntries<T extends { ts: string }>(
  entries: T[],
  maxEntries: number,
  cutoffMs: number,
): void {
  const retained = entries.filter((entry) => {
    const tsMs = Date.parse(entry.ts);
    return Number.isFinite(tsMs) && tsMs >= cutoffMs;
  });

  const overflow = Math.max(0, retained.length - maxEntries);
  const next = overflow > 0 ? retained.slice(overflow) : retained;
  entries.splice(0, entries.length, ...next);
}
