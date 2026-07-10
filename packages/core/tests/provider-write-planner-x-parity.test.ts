import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  assertHasPath,
  assertMalformedNangoMessageAcked,
  assertTodayDigestIncludes,
  assertWriterEmitsPaths,
  planSmokeWrites,
} from "./provider-write-planner-smoke-helpers.js";

const requestedAt = "2026-05-17T10:00:00.000Z";

const xSearchBundle = {
  id: "search-1",
  run: {
    id: "search-1",
    title: "Agent Relay",
    query: "agent relay",
    mode: "recent",
    requestedAt,
    resultCount: 1,
    costEstimate: {
      posts: 1,
      users: 1,
      postReadUnitUsd: 0.005,
      userReadUnitUsd: 0.01,
      estimatedUsd: 0.015,
      cappedByBudget: false,
      cappedByMaxResults: false,
    },
    source: {
      provider: "x",
      endpoint: "/2/tweets/search/recent",
      docs: "https://docs.x.com/x-api/posts/search/introduction",
    },
  },
  posts: [{
    id: "post-1",
    text: "Relayfile social search",
    author_id: "user-1",
    conversation_id: "conversation-1",
    created_at: requestedAt,
  }],
  users: [{ id: "user-1", username: "agentrelay", name: "Agent Relay" }],
  results: [{
    id: "search-1:post-1",
    searchId: "search-1",
    postId: "post-1",
    rank: 1,
    matchedAt: requestedAt,
    canonicalPath: "/x/posts/relayfile-social-search__post-1.json",
    query: "agent relay",
  }],
  rawResponses: [],
};

const xSearchBundleSchema = z.object({
  id: z.string(),
  run: z.object({
    id: z.string(),
    title: z.string(),
    query: z.string(),
    mode: z.enum(["recent", "archive"]),
    requestedAt: z.string(),
    resultCount: z.number(),
    costEstimate: z.object({
      posts: z.number(),
      users: z.number(),
      postReadUnitUsd: z.number(),
      userReadUnitUsd: z.number(),
      estimatedUsd: z.number(),
      cappedByBudget: z.boolean(),
      cappedByMaxResults: z.boolean(),
    }),
    source: z.object({
      provider: z.literal("x"),
      endpoint: z.enum(["/2/tweets/search/recent", "/2/tweets/search/all"]),
      docs: z.string(),
    }),
  }).passthrough(),
  posts: z.array(z.object({ id: z.string(), text: z.string() }).passthrough()),
  users: z.array(z.object({ id: z.string() }).passthrough()),
  results: z.array(z.object({
    id: z.string(),
    searchId: z.string(),
    postId: z.string(),
    rank: z.number(),
    matchedAt: z.string(),
    query: z.string(),
  }).passthrough()),
  rawResponses: z.array(z.unknown()),
}).passthrough();

function xJob(): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_test",
    provider: "x",
    providerConfigKey: "x-relay",
    connectionId: "conn_test",
    syncName: "fetch-searches",
    model: "XSearchBundle",
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

describe("x-relay smoke parity", () => {
  it("sampled XSearchBundle satisfies the declared zod contract", () => {
    assert.ok(xSearchBundleSchema.safeParse(xSearchBundle).success);
  });

  it("plans and writes canonical, index, and one by-* alias path", async () => {
    const expected = [
      "/x/searches/search-1__agent-relay/meta.json",
      "/x/searches/_index.json",
      "/x/searches/by-id/search-1.json",
    ];
    const writes = planSmokeWrites(xJob(), xSearchBundle);
    for (const path of expected) assertHasPath(writes, path);

    await assertWriterEmitsPaths(xJob(), xSearchBundle, expected);
  });

  it("surfaces an X record in today's digest", async () => {
    await assertTodayDigestIncludes(
      "x",
      "/x/searches/search-1__agent-relay/meta.json",
      JSON.stringify(xSearchBundle),
    );
  });

  it("acks malformed provider queue bodies without retrying", async () => {
    await assertMalformedNangoMessageAcked("x-relay", "fetch-searches", "XSearchBundle");
  });
});
