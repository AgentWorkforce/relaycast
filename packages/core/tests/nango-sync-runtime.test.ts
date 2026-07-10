import assert from "node:assert/strict";
import { test } from "node:test";

import {
  processNangoSyncPage,
  type NangoSyncPageDeps,
} from "../src/sync/nango-sync-runtime.js";
import { providerModelKey } from "../src/sync/provider-write-planner.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";

const baseJob: NangoSyncJob = {
  type: "nango_sync",
  workspaceId: "app-workspace",
  relayWorkspaceId: "relay-workspace",
  provider: "neon",
  providerConfigKey: "neon-relay",
  connectionId: "conn-neon",
  syncName: "neon-sync",
  model: "NeonOperation",
  modifiedAfter: "2026-06-18T08:00:00.000Z",
  syncType: "INCREMENTAL",
  cursor: null,
};

function depsFor(input: {
  records: Record<string, unknown>[];
  writeErrors?: number;
  errorSamples?: Array<{
    path: string;
    code: string;
    message: string;
    ownerOffsets: number[];
  }>;
  calls: string[];
}): NangoSyncPageDeps {
  return {
    nango: {
      async listRecords() {
        input.calls.push("list");
        return { records: input.records, next_cursor: null };
      },
    },
    relayfile: {
      async writeBatch() {
        input.calls.push("write");
        return {
          written: input.records.length,
          deleted: 0,
          errors: input.writeErrors ?? 0,
          ...(input.errorSamples ? { errorSamples: input.errorSamples } : {}),
        };
      },
    },
    syncDeltaEvents: {
      async preparePage({ job, writeJob, records, suppressEvents }) {
        input.calls.push("prepare");
        assert.equal(job.workspaceId, "app-workspace");
        assert.equal(writeJob.workspaceId, "relay-workspace");
        assert.deepEqual(records, input.records);
        assert.equal(suppressEvents, false);
        return {
          async dispatch() {
            input.calls.push("dispatch");
          },
        };
      },
    },
    enabledProviderModels: new Set([providerModelKey(baseJob)]),
  };
}

test("processNangoSyncPage prepares delta events before write and dispatches after successful write", async () => {
  const calls: string[] = [];

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    depsFor({ records: [{ id: "op-1" }], calls }),
  );

  assert.deepEqual(calls, ["list", "prepare", "write", "dispatch"]);
  assert.deepEqual(result, {
    nextCursor: null,
    written: 1,
    deleted: 0,
    errors: [],
  });
});

test("processNangoSyncPage suppresses delta events during initial sync windows", async () => {
  const calls: string[] = [];
  let suppressFlag: boolean | null = null;
  const deps = depsFor({ records: [{ id: "op-1" }], calls });
  deps.syncDeltaEvents = {
    async preparePage({ suppressEvents }) {
      calls.push("prepare");
      suppressFlag = suppressEvents;
      return null;
    },
  };

  await processNangoSyncPage(
    { ...baseJob, syncType: "INITIAL", checkpoints: { from: null } },
    { cursor: null, recordOffset: 0 },
    deps,
  );

  assert.equal(suppressFlag, true);
  assert.deepEqual(calls, ["list", "prepare", "write"]);
});

test("processNangoSyncPage skips delta dispatch when writeBatch reports partial errors", async () => {
  const calls: string[] = [];

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    depsFor({ records: [{ id: "op-1" }], writeErrors: 1, calls }),
  );

  assert.deepEqual(calls, ["list", "prepare", "write"]);
  assert.deepEqual(result.errors, ["batch_partial_errors:1"]);
});

test("processNangoSyncPage treats empty incremental pages as non-destructive no-ops", async () => {
  const calls: string[] = [];

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    depsFor({ records: [], calls }),
  );

  assert.deepEqual(calls, ["list", "write"]);
  assert.deepEqual(result, {
    nextCursor: null,
    written: 0,
    deleted: 0,
    errors: [],
  });
});

test("processNangoSyncPage includes redacted bulk error samples when available", async () => {
  const calls: string[] = [];
  const errorSamples = [
    {
      path: "/linear/labels/label-1.json",
      code: "commit_not_visible",
      message: "committed file was not visible after flush",
      ownerOffsets: [0],
    },
  ];

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    depsFor({
      records: [{ id: "label-1" }],
      writeErrors: 1,
      errorSamples,
      calls,
    }),
  );

  assert.deepEqual(calls, ["list", "prepare", "write"]);
  assert.deepEqual(result.errors, ["batch_partial_errors:1"]);
  assert.deepEqual(result.errorSamples, errorSamples);
});

test("processNangoSyncPage checkpoints large page writes at bounded record offsets", async () => {
  const calls: string[] = [];
  const records = Array.from({ length: 5 }, (_, index) => ({ id: `issue-${index}` }));
  let preparedRecords: readonly Record<string, unknown>[] = [];
  let writeStartOffset: number | undefined;
  let writeRecordOffset: number | undefined;

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    {
      nango: {
        async listRecords() {
          calls.push("list");
          return { records, next_cursor: "next-page" };
        },
      },
      relayfile: {
        async writeBatch(inputRecords, writeJob, options) {
          calls.push("write");
          assert.equal(inputRecords, records);
          writeStartOffset = options?.startOffset;
          writeRecordOffset = writeJob.recordOffset;
          assert.equal(options?.shouldCheckpoint?.(2), true);
          assert.equal(options?.shouldCheckpoint?.(5), false);
          return {
            written: 2,
            deleted: 0,
            errors: 0,
            checkpointOffset: 2,
          };
        },
      },
      syncDeltaEvents: {
        async preparePage({ records: pageRecords }) {
          calls.push("prepare");
          preparedRecords = pageRecords;
          return {
            async dispatch() {
              calls.push("dispatch");
            },
          };
        },
      },
      enabledProviderModels: new Set([providerModelKey(baseJob)]),
      writeChunkSize: 2,
      writeConcurrency: 2,
    },
  );

  assert.deepEqual(calls, ["list", "prepare", "write", "dispatch"]);
  assert.deepEqual(preparedRecords, records.slice(0, 2));
  assert.equal(writeStartOffset, 0);
  assert.equal(writeRecordOffset, undefined);
  assert.deepEqual(result, {
    nextCursor: "next-page",
    nextRecordOffset: 2,
    written: 2,
    deleted: 0,
    errors: [],
  });
});

test("processNangoSyncPage resumes from a mid-page offset without leaking stale job offsets", async () => {
  const records = Array.from({ length: 5 }, (_, index) => ({ id: `issue-${index}` }));
  let preparedRecords: readonly Record<string, unknown>[] = [];
  let writeStartOffset: number | undefined;
  let writeRecordOffset: number | undefined;

  const result = await processNangoSyncPage(
    { ...baseJob, recordOffset: 99 },
    { cursor: "same-page", recordOffset: 2 },
    {
      nango: {
        async listRecords(request) {
          assert.equal(request.cursor, "same-page");
          return { records, next_cursor: "next-page" };
        },
      },
      relayfile: {
        async writeBatch(_inputRecords, writeJob, options) {
          writeStartOffset = options?.startOffset;
          writeRecordOffset = writeJob.recordOffset;
          assert.equal(options?.shouldCheckpoint?.(4), true);
          return {
            written: 2,
            deleted: 0,
            errors: 0,
            checkpointOffset: 4,
          };
        },
      },
      syncDeltaEvents: {
        async preparePage({ records: pageRecords, writeJob }) {
          preparedRecords = pageRecords;
          assert.equal(writeJob.cursor, "same-page");
          assert.equal(writeJob.recordOffset, 2);
          return null;
        },
      },
      enabledProviderModels: new Set([providerModelKey(baseJob)]),
      writeChunkSize: 2,
      writeConcurrency: 2,
    },
  );

  assert.deepEqual(preparedRecords, records.slice(2, 4));
  assert.equal(writeStartOffset, 2);
  assert.equal(writeRecordOffset, 2);
  assert.deepEqual(result, {
    nextCursor: "next-page",
    nextRecordOffset: 4,
    written: 2,
    deleted: 0,
    errors: [],
  });
});

test("processNangoSyncPage advances the Nango cursor after the final page chunk", async () => {
  const records = Array.from({ length: 5 }, (_, index) => ({ id: `issue-${index}` }));
  let preparedRecords: readonly Record<string, unknown>[] = [];

  const result = await processNangoSyncPage(
    { ...baseJob, recordOffset: 99 },
    { cursor: "same-page", recordOffset: 4 },
    {
      nango: {
        async listRecords() {
          return { records, next_cursor: "next-page" };
        },
      },
      relayfile: {
        async writeBatch(_inputRecords, writeJob, options) {
          assert.equal(options?.startOffset, 4);
          assert.equal(writeJob.recordOffset, 4);
          assert.equal(options?.shouldCheckpoint?.(5), false);
          return {
            written: 1,
            deleted: 0,
            errors: 0,
          };
        },
      },
      syncDeltaEvents: {
        async preparePage({ records: pageRecords }) {
          preparedRecords = pageRecords;
          return null;
        },
      },
      enabledProviderModels: new Set([providerModelKey(baseJob)]),
      writeChunkSize: 2,
      writeConcurrency: 2,
    },
  );

  assert.deepEqual(preparedRecords, records.slice(4, 5));
  assert.deepEqual(result, {
    nextCursor: "next-page",
    written: 1,
    deleted: 0,
    errors: [],
  });
});

test("processNangoSyncPage aligns unaligned write chunks to writer concurrency", async () => {
  const records = Array.from({ length: 25 }, (_, index) => ({ id: `issue-${index}` }));
  let preparedRecords: readonly Record<string, unknown>[] = [];

  const result = await processNangoSyncPage(
    baseJob,
    { cursor: null, recordOffset: 0 },
    {
      nango: {
        async listRecords() {
          return { records, next_cursor: null };
        },
      },
      relayfile: {
        async writeBatch(_inputRecords, _writeJob, options) {
          assert.equal(options?.startOffset, 0);
          assert.equal(options?.shouldCheckpoint?.(10), true);
          assert.equal(options?.shouldCheckpoint?.(12), true);
          assert.equal(options?.shouldCheckpoint?.(25), false);
          return {
            written: 10,
            deleted: 0,
            errors: 0,
            checkpointOffset: 10,
          };
        },
      },
      syncDeltaEvents: {
        async preparePage({ records: pageRecords }) {
          preparedRecords = pageRecords;
          return null;
        },
      },
      enabledProviderModels: new Set([providerModelKey(baseJob)]),
      writeChunkSize: 12,
      writeConcurrency: 10,
    },
  );

  assert.deepEqual(preparedRecords, records.slice(0, 10));
  assert.deepEqual(result, {
    nextCursor: null,
    nextRecordOffset: 10,
    written: 10,
    deleted: 0,
    errors: [],
  });
});
