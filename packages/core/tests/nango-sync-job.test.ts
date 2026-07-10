import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNangoSyncJob } from "../src/sync/nango-sync-job.js";

const baseJob = {
  type: "nango_sync",
  provider: "linear",
  connectionId: "conn-linear-1",
  providerConfigKey: "linear-relay",
  syncName: "fetch-labels",
  model: "LinearLabel",
  cursor: null,
  workspaceId: "55555555-5555-4555-8555-555555555555",
};

describe("parseNangoSyncJob", () => {
  it("accepts null modifiedAfter for full initial sync fetches", () => {
    assert.deepEqual(parseNangoSyncJob({ ...baseJob, modifiedAfter: null }), {
      ...baseJob,
      modifiedAfter: null,
    });
  });

  it("accepts string modifiedAfter for incremental sync fetches", () => {
    assert.deepEqual(
      parseNangoSyncJob({
        ...baseJob,
        modifiedAfter: "2026-06-17T17:10:00.000Z",
      }),
      {
        ...baseJob,
        modifiedAfter: "2026-06-17T17:10:00.000Z",
      },
    );
  });
});
