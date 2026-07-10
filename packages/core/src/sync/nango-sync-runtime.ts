import type { NangoSyncJob } from "./nango-sync-job.js";
import {
  planProviderRecordWrites,
  type ProviderModelKey,
} from "./provider-write-planner.js";

export const NANGO_SYNC_DEFAULT_PAGE_SIZE = 100;
export const NANGO_SYNC_WRITE_CHUNK_SIZE = 20;
export const NANGO_SYNC_DEFAULT_WRITE_CONCURRENCY = 10;

export type NangoRecordPage<T extends Record<string, unknown> = Record<string, unknown>> = {
  records: T[];
  next_cursor: string | null;
};

export interface NangoRecordsClient {
  listRecords<T extends Record<string, unknown> = Record<string, unknown>>(config: {
    providerConfigKey: string;
    connectionId: string;
    model: string;
    modifiedAfter?: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<NangoRecordPage<T>>;
}

export type NangoListRecordsRequest = Parameters<NangoRecordsClient["listRecords"]>[0];

export interface RelayfileBatchWriter {
  readFile?(
    workspaceId: string,
    path: string,
  ): Promise<string | { content?: string } | null>;
  writeBatch(
    records: readonly Record<string, unknown>[],
    job: NangoSyncJob,
    options?: {
      startOffset?: number;
      shouldCheckpoint?: (nextOffset: number) => boolean;
    },
  ): Promise<{
    written: number;
    deleted: number;
    errors: number;
    checkpointOffset?: number;
    errorSamples?: Array<{
      path: string;
      code: string;
      message: string;
      ownerOffsets: number[];
    }>;
  }>;
}

export type NangoSyncDeltaDispatchPlan = {
  dispatch(): Promise<void>;
};

export type NangoSyncDeltaEventHooks = {
  preparePage(input: {
    job: NangoSyncJob;
    writeJob: NangoSyncJob;
    records: readonly Record<string, unknown>[];
    relayfile: RelayfileBatchWriter;
    suppressEvents: boolean;
  }): Promise<NangoSyncDeltaDispatchPlan | null> | NangoSyncDeltaDispatchPlan | null;
};

function normalizeCursor(value: string | null | undefined): string | null {
  const cursor = value?.trim();
  return cursor ? cursor : null;
}

function isInitialSyncWindow(job: Pick<NangoSyncJob, "syncType" | "checkpoints">): boolean {
  return job.syncType === "INITIAL" || job.checkpoints?.from === null;
}

export function buildNangoListRecordsRequest(
  job: NangoSyncJob,
  state: { cursor: string | null },
  pageSize: number,
): NangoListRecordsRequest {
  const cursor = normalizeCursor(state.cursor);
  return {
    providerConfigKey: job.providerConfigKey,
    connectionId: job.connectionId,
    model: job.model,
    limit: pageSize,
    ...(cursor ? { cursor } : {}),
    ...(!isInitialSyncWindow(job) && job.modifiedAfter
      ? { modifiedAfter: job.modifiedAfter }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Single-page extraction — used by the CF Workflows path.
// No deadline / checkpoint logic: Workflows handle retries at the step level.
// ---------------------------------------------------------------------------

export type NangoSyncPageDeps = {
  nango: NangoRecordsClient;
  relayfile: RelayfileBatchWriter;
  syncDeltaEvents?: NangoSyncDeltaEventHooks;
  enabledProviderModels?: ReadonlySet<ProviderModelKey>;
  pageSize?: number;
  writeChunkSize?: number;
  writeConcurrency?: number;
};

export type NangoSyncPageResult = {
  nextCursor: string | null;
  /** Present when the workflow should refetch the same Nango cursor and resume within the page. */
  nextRecordOffset?: number;
  written: number;
  deleted: number;
  /** Non-empty when writeBatch reports partial failures. */
  errors: string[];
  errorSamples?: Array<{
    path: string;
    code: string;
    message: string;
    ownerOffsets: number[];
  }>;
};

export async function processNangoSyncPage(
  job: NangoSyncJob,
  state: { cursor: string | null; recordOffset: number },
  deps: NangoSyncPageDeps,
): Promise<NangoSyncPageResult> {
  const { cursor, recordOffset } = state;
  const pageSize = deps.pageSize ?? NANGO_SYNC_DEFAULT_PAGE_SIZE;
  const writeConcurrency =
    Number.isFinite(deps.writeConcurrency) && deps.writeConcurrency! > 0
      ? Math.floor(deps.writeConcurrency!)
      : NANGO_SYNC_DEFAULT_WRITE_CONCURRENCY;
  const rawWriteChunkSize =
    Number.isFinite(deps.writeChunkSize) && deps.writeChunkSize! > 0
      ? Math.floor(deps.writeChunkSize!)
      : NANGO_SYNC_WRITE_CHUNK_SIZE;
  // writeBatchToRelayfile evaluates shouldCheckpoint only after its internal
  // concurrency-sized planning chunks. Align the requested page slice to that
  // boundary so prepared delta events cover exactly the records written.
  const writeChunkSize = Math.max(
    writeConcurrency,
    Math.round(rawWriteChunkSize / writeConcurrency) * writeConcurrency,
  );

  const listRequest = buildNangoListRecordsRequest(job, { cursor }, pageSize);
  const page = await deps.nango.listRecords(listRequest);
  const normalizedCursor = normalizeCursor(cursor);
  const normalizedNextCursor = normalizeCursor(page.next_cursor);
  const startOffset = Math.min(Math.max(0, recordOffset), page.records.length);
  const targetCheckpointOffset = Math.min(
    page.records.length,
    startOffset + writeChunkSize,
  );

  // DIAG (#2254): trace why INITIAL syncs (e.g. LinearLabel) can materialize 0
  // records despite Nango holding records. Surfaces the modifiedAfter gate
  // inputs (syncType / checkpoints.from / job.modifiedAfter), the filter that
  // was actually applied to the request, and the fetched count — disambiguating
  // "listRecords returned nothing" from "writeBatch dropped them". Remove once
  // the initial-sync-window root cause is confirmed and fixed.
  console.log(
    JSON.stringify({
      area: "diag/nango-page-fetch",
      model: job.model,
      providerConfigKey: job.providerConfigKey,
      syncType: job.syncType ?? null,
      checkpointFrom: job.checkpoints?.from ?? null,
      jobModifiedAfter: job.modifiedAfter ?? null,
      requestModifiedAfter: listRequest.modifiedAfter ?? null,
      cursor: normalizedCursor,
      recordOffset: startOffset,
      fetched: page.records.length,
      writeChunkSize,
      writeConcurrency,
    }),
  );

  // Validates parity enablement and plans writes (result intentionally unused —
  // writeBatchToRelayfile re-plans internally; this call is for early rejection).
  planProviderRecordWrites(job, page.records, deps.enabledProviderModels);

  const { recordOffset: _jobRecordOffset, ...jobWithoutRecordOffset } = job;
  const writeJob: NangoSyncJob = {
    ...jobWithoutRecordOffset,
    cursor: normalizedCursor,
    ...(startOffset > 0 ? { recordOffset: startOffset } : {}),
    workspaceId: job.relayWorkspaceId?.trim() || job.workspaceId,
  };
  const recordsForDeltaEvents = page.records.slice(
    startOffset,
    targetCheckpointOffset,
  );
  const deltaDispatchPlan = recordsForDeltaEvents.length > 0
    ? await deps.syncDeltaEvents?.preparePage({
      job,
      writeJob,
      records: recordsForDeltaEvents,
      relayfile: deps.relayfile,
      suppressEvents: isInitialSyncWindow(job),
    }) ?? null
    : null;
  const result = await deps.relayfile.writeBatch(page.records, writeJob, {
    startOffset,
    shouldCheckpoint: (nextOffset) =>
      nextOffset >= targetCheckpointOffset && nextOffset < page.records.length,
  });

  if (result.errors === 0) {
    await deltaDispatchPlan?.dispatch();
  }

  // DIAG (#2254): pair the fetch log above with the write outcome so a
  // fetched>0 / written=0 case points at the bucketing/emit path rather than
  // the fetch. Remove alongside the fetch diag.
  console.log(
    JSON.stringify({
      area: "diag/nango-page-write",
      model: job.model,
      fetched: page.records.length,
      recordOffset: startOffset,
      checkpointOffset: result.checkpointOffset ?? null,
      written: result.written,
      deleted: result.deleted,
      errors: result.errors,
      errorSamples: result.errorSamples,
    }),
  );

  return {
    nextCursor: normalizedNextCursor,
    ...(result.checkpointOffset !== undefined &&
    result.checkpointOffset > startOffset &&
    result.checkpointOffset < page.records.length
      ? { nextRecordOffset: result.checkpointOffset }
      : {}),
    written: result.written,
    deleted: result.deleted,
    errors: result.errors > 0 ? [`batch_partial_errors:${result.errors}`] : [],
    ...(result.errorSamples && result.errorSamples.length > 0
      ? { errorSamples: result.errorSamples }
      : {}),
  };
}
