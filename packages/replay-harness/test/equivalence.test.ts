import { describe, expect, it } from "vitest";

import { compareReplayResult, parseAllowlistEntries } from "../src/equivalence.js";
import type { CorpusEntry } from "../src/corpus.js";
import type { ReplayedResponse } from "../src/replay.js";

function createRecordedEntry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    timestamp: "2026-05-14T13:00:00.000Z",
    method: "GET",
    path: "/api/v1/example",
    query: "",
    headers: {
      accept: "application/json",
    },
    body: null,
    response_status: 200,
    response_headers: {
      "content-type": "application/json",
    },
    response_body: JSON.stringify({
      item: {
        id: "abc123",
        updatedAt: "2026-05-14T13:00:00.000Z",
      },
    }),
    request_id: "req-1",
    ...overrides,
  };
}

function createReplayResponse(overrides: Partial<ReplayedResponse> = {}): ReplayedResponse {
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      item: {
        id: "abc123",
        updatedAt: "2026-05-14T13:00:00.000Z",
      },
    }),
    url: "https://example.test/api/v1/example",
    ...overrides,
  };
}

describe("compareReplayResult", () => {
  it("returns identical when the recorded and replayed responses match", () => {
    const result = compareReplayResult(
      createRecordedEntry(),
      createReplayResponse(),
      [],
    );

    expect(result.kind).toBe("identical");
    expect(result.details.allowlistedDifferences).toHaveLength(0);
    expect(result.details.divergentDifferences).toHaveLength(0);
  });

  it("returns allowlisted for a path-scoped body difference", () => {
    const allowlist = parseAllowlistEntries([
      {
        path: "/api/v1/example",
        method: "GET",
        field: "item.updatedAt",
        kind: "type-only",
        reason: "Updated timestamps are expected to move between capture and replay.",
      },
    ]);

    const result = compareReplayResult(
      createRecordedEntry(),
      createReplayResponse({
        body: JSON.stringify({
          item: {
            id: "abc123",
            updatedAt: "2026-05-14T13:01:00.000Z",
          },
        }),
      }),
      allowlist,
    );

    expect(result.kind).toBe("allowlisted");
    expect(result.details.allowlistedDifferences).toEqual([
      expect.objectContaining({
        field: "item.updatedAt",
      }),
    ]);
    expect(result.details.divergentDifferences).toHaveLength(0);
  });

  it("returns divergent when a difference is not allowlisted", () => {
    const result = compareReplayResult(
      createRecordedEntry(),
      createReplayResponse({
        body: JSON.stringify({
          item: {
            id: "xyz789",
            updatedAt: "2026-05-14T13:00:00.000Z",
          },
        }),
      }),
      [],
    );

    expect(result.kind).toBe("divergent");
    expect(result.details.divergentDifferences).toEqual([
      expect.objectContaining({
        field: "item.id",
        expected: "abc123",
        actual: "xyz789",
      }),
    ]);
  });
});
