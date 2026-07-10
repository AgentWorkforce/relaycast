import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  ProviderNotParityEnabledError,
  REPO_DECLARED_NANGO_PROVIDER_MODELS,
  planProviderRecordWrites,
  providerModelKey,
} from "../src/sync/provider-write-planner.js";

function job(overrides: Partial<NangoSyncJob> = {}): NangoSyncJob {
  return {
    type: "nango_sync",
    provider: "confluence",
    providerConfigKey: "confluence-relay",
    connectionId: "conn_1",
    syncName: "fetch-spaces",
    model: "ConfluenceSpace",
    modifiedAfter: "2026-05-19T00:00:00.000Z",
    cursor: null,
    workspaceId: "rw_test",
    ...overrides,
  };
}

describe("provider write planner", () => {
  it("hard-disables provider/model keys missing from the enabled allowlist", () => {
    const declaredEntry = REPO_DECLARED_NANGO_PROVIDER_MODELS[0];
    assert.ok(declaredEntry, "test requires at least one provider/model row");

    assert.throws(
      () =>
        planProviderRecordWrites(
          job({
            provider: declaredEntry.provider.replace(/-relay$/, ""),
            providerConfigKey: declaredEntry.provider,
            syncName: declaredEntry.sync,
            model: declaredEntry.model,
          }),
          [{ id: "deferred-row-1" }],
          new Set(),
        ),
      ProviderNotParityEnabledError,
    );
  });

  it("exposes the current repo-declared provider/model cutover checklist", () => {
    const keys = new Set(REPO_DECLARED_NANGO_PROVIDER_MODELS.map((entry) => entry.key));
    assert.ok(keys.has("confluence-relay:fetch-spaces:ConfluenceSpace"));
    assert.ok(keys.has("google-mail-relay:fetch-messages:GoogleMailMessage"));
    assert.ok(keys.has("google-calendar-relay:fetch-events:GoogleCalendarEvent"));
    assert.equal(
      REPO_DECLARED_NANGO_PROVIDER_MODELS.every(
        (entry) =>
          entry.classification === "enabled" ||
          entry.classification === "deferred" ||
          entry.classification === "smoke-deferred",
      ),
      true,
    );
  });

  it("allows only explicitly enabled provider/model keys", () => {
    const input = job();
    const plan = planProviderRecordWrites(
      input,
      [{ id: "space-1" }],
      new Set([providerModelKey(input)]),
    );
    assert.equal(plan.written, 1);
    assert.equal(plan.deleted, 0);
    assert.ok(plan.writes.some((write) => write.path === "/confluence/spaces/space-1.json"));
  });
});
