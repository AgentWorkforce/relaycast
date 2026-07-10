import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Resource } from "sst";

import { createRelayfileWritebackPgliteDb } from "./helpers/relayfile-writeback-pglite-db.ts";
import {
  startMockNangoSdkServer,
  type NangoMockRequest,
} from "./helpers/mock-nango-sdk-server.ts";

type BridgeInput = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
  action?: "file_upsert" | "file_delete";
  content: string;
  contentType?: string;
  encoding?: string;
};

type BridgeModule = {
  handleRelayfileProviderWriteback: (
    input: BridgeInput,
  ) => Promise<{
    outcome: string;
    provider: string;
    relayfileAcked: boolean;
    metadata?: { status?: number; externalId?: string; action?: string };
  }>;
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BASE_TIMESTAMP = new Date("2026-04-17T09:00:00.000Z");
const NANGO_SECRET = "nango-secret-for-tests";
const RELAYAUTH_URL = "https://relayauth.test";
const RELAYAUTH_API_KEY = "relayauth-api-key-for-tests";

function stubRelayAuthFetch(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${RELAYAUTH_URL}/v1/identities`) {
      return new Response(JSON.stringify({ id: "identity-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `${RELAYAUTH_URL}/v1/tokens`) {
      return new Response(JSON.stringify({ accessToken: "relayfile-token-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

async function loadBridgeModule(): Promise<BridgeModule> {
  return import(
    new URL(
      "../packages/web/lib/integrations/relayfile-writeback-bridge.ts",
      import.meta.url,
    ).href
  ) as Promise<BridgeModule>;
}

async function resetNangoClient(): Promise<void> {
  const mod = await import(
    new URL(
      "../packages/web/lib/integrations/nango-service.ts",
      import.meta.url,
    ).href
  );
  mod.resetNangoClientForTests();
}

function collectConsoleOutput(spyCalls: unknown[][]): string {
  return spyCalls
    .flat()
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
}

describe("relayfile writeback bridge", () => {
  let cleanupDb: (() => Promise<void>) | undefined;
  let nangoServer: Awaited<ReturnType<typeof startMockNangoSdkServer>> | undefined;
  let originalFetch: typeof fetch | undefined;
  let originalConsoleError: typeof console.error | undefined;
  let originalConsoleWarn: typeof console.warn | undefined;
  let consoleErrorCalls: unknown[][];
  let consoleWarnCalls: unknown[][];

  beforeEach(async () => {
    process.env.NANGO_SECRET_KEY = NANGO_SECRET;
    process.env.RELAYFILE_URL = "https://relayfile.test";
    process.env.RELAY_JWT_SECRET = "relay-jwt-secret-for-tests";
    process.env.RELAYAUTH_URL = RELAYAUTH_URL;
    process.env.RELAYAUTH_API_KEY = RELAYAUTH_API_KEY;

    (Resource as unknown as Record<string, unknown>).NangoSecretKey = {
      value: NANGO_SECRET,
    };
    (Resource as unknown as Record<string, unknown>).RelayJwtSecret = {
      value: "relay-jwt-secret-for-tests",
    };

    consoleErrorCalls = [];
    consoleWarnCalls = [];
    originalFetch = globalThis.fetch;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;
    console.error = ((...args: unknown[]) => {
      consoleErrorCalls.push(args);
    }) as typeof console.error;
    console.warn = ((...args: unknown[]) => {
      consoleWarnCalls.push(args);
    }) as typeof console.warn;

    await resetNangoClient();
  });

  afterEach(async () => {
    if (cleanupDb) {
      await cleanupDb();
      cleanupDb = undefined;
    }
    if (nangoServer) {
      await nangoServer.close();
      nangoServer = undefined;
    }

    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    if (originalConsoleError) {
      console.error = originalConsoleError;
    }
    if (originalConsoleWarn) {
      console.warn = originalConsoleWarn;
    }

    delete process.env.NANGO_HOST;
    delete process.env.NANGO_SECRET_KEY;
    delete process.env.RELAYFILE_URL;
    delete process.env.RELAY_JWT_SECRET;
    delete process.env.RELAYAUTH_URL;
    delete process.env.RELAYAUTH_API_KEY;
    await resetNangoClient();
  });

  async function bindNangoMock(
    respond: (request: NangoMockRequest) =>
      | { status: number; body?: unknown; headers?: Record<string, string> }
      | null,
  ): Promise<Awaited<ReturnType<typeof startMockNangoSdkServer>>> {
    nangoServer = await startMockNangoSdkServer({ secret: NANGO_SECRET, respond });
    process.env.NANGO_HOST = nangoServer.url;
    await resetNangoClient();
    return nangoServer;
  }

  it("PATCHes Notion page properties and acknowledges the RelayFile operation", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_123",
      providerConfigKey: "notion-sage",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: { id: "page-1" },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_notion_success/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_notion_success", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_notion_success",
      workspaceId: WORKSPACE_ID,
      path: "/notion/databases/db-1/pages/11111111-1111-4111-8111-111111111112.json",
      revision: "rev_1",
      correlationId: "corr_notion_success",
      content: JSON.stringify({
        properties: {
          Name: { id: "title", type: "title", value: "Updated by bridge" },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "notion");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "update_page_properties");
    assert.equal(result.metadata?.externalId, "page-1");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "PATCH");
    assert.equal(call.endpoint, "/v1/pages/11111111-1111-4111-8111-111111111112");
    assert.equal(call.connectionId, "conn_notion_123");
    assert.equal(call.providerConfigKey, "notion-sage");
    assert.equal(call.authorization, `Bearer ${NANGO_SECRET}`);

    assert.equal(ackCalls.length, 1);
    assert.match(ackCalls[0].url, /\/writeback\/op_notion_success\/ack$/);
    assert.deepEqual(ackCalls[0].body, {
      success: true,
      providerResult: {
        provider: "notion",
        action: "update_page_properties",
        method: "PATCH",
        endpoint: "/v1/pages/11111111-1111-4111-8111-111111111112",
        status: 200,
        externalId: "page-1",
      },
    });

    const output = `${collectConsoleOutput(consoleErrorCalls)}\n${collectConsoleOutput(consoleWarnCalls)}`;
    assert.equal(output.includes("Authorization"), false);
    assert.equal(output.includes(NANGO_SECRET), false);
  });

  it("submits supported GitHub pull-request review writebacks and then ACKs success", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github_123",
      providerConfigKey: "github-sage",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: { id: 987654321 },
    }));

    const ackCalls: string[] = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_github_review/ack")) {
        ackCalls.push(url);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body.success, true);
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_github_review", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_github_review",
      workspaceId: WORKSPACE_ID,
      path: "/github/repos/AgentWorkforce/cloud/pulls/123/reviews/agent-review.json",
      revision: "rev_2",
      correlationId: "corr_github_review",
      content: JSON.stringify({
        event: "COMMENT",
        body: "Please address the inline note.",
        comments: [
          {
            path: "src/index.ts",
            line: 5,
            body: "Rename this variable before merge.",
            side: "RIGHT",
          },
        ],
        metadata: { commitSha: "abc123def456" },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "github");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.externalId, "987654321");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "POST");
    assert.equal(call.endpoint, "/repos/AgentWorkforce/cloud/pulls/123/reviews");
    assert.equal(call.connectionId, "conn_github_123");
    assert.equal(call.providerConfigKey, "github-sage");

    assert.equal(ackCalls.length, 1);
  });

  it("submits GitHub pull-request merge writebacks and then ACKs success", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github_merge",
      providerConfigKey: "github-sage",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: { merged: true, sha: "abc123merge" },
    }));

    const ackCalls: string[] = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_github_merge/ack")) {
        ackCalls.push(url);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body.success, true);
        assert.deepEqual(body.providerResult, {
          provider: "github",
          action: "merge_pull_request",
          method: "PUT",
          endpoint: "/repos/AgentWorkforce/cloud/pulls/123/merge",
          status: 200,
          externalId: "abc123merge",
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_github_merge", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_github_merge",
      workspaceId: WORKSPACE_ID,
      path: "/github/repos/AgentWorkforce/cloud/pulls/123/merge.json",
      revision: "rev_merge",
      correlationId: "corr_github_merge",
      content: JSON.stringify({
        method: "squash",
        commitTitle: "Merge pull request #123",
        commitMessage: "Approved by review agent.",
        sha: "reviewed-head",
        metadata: {
          connectionId: "conn_github_override",
          providerConfigKey: "github-override",
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    if (result.outcome !== "success") assert.fail(JSON.stringify(result));
    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "github");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "merge_pull_request");
    assert.equal(result.metadata?.externalId, "abc123merge");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "PUT");
    assert.equal(call.endpoint, "/repos/AgentWorkforce/cloud/pulls/123/merge");
    assert.equal(call.connectionId, "conn_github_override");
    assert.equal(call.providerConfigKey, "github-override");
    assert.deepEqual(call.body, {
      merge_method: "squash",
      commit_title: "Merge pull request #123",
      commit_message: "Approved by review agent.",
      sha: "reviewed-head",
    });

    assert.equal(ackCalls.length, 1);
  });

  it("rejects malformed GitHub pull-request merge payloads and ACKs permanent failure", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "github",
      connectionId: "conn_github_merge",
      providerConfigKey: "github-sage",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const ackCalls: string[] = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_github_merge_invalid/ack")) {
        ackCalls.push(url);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body.success, false);
        assert.match(String(body.error), /payload\.method must be one of merge, squash, rebase/);
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_github_merge_invalid", success: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_github_merge_invalid",
      workspaceId: WORKSPACE_ID,
      path: "/github/repos/AgentWorkforce/cloud/pulls/123/merge.json",
      revision: "rev_merge_invalid",
      correlationId: "corr_github_merge_invalid",
      content: JSON.stringify({ merge_method: null }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "permanent_failure");
    assert.equal(result.relayfileAcked, true);
    assert.equal(ackCalls.length, 1);
  });

  it("submits Slack chat.postMessage via the Nango proxy and acknowledges success", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn_slack_post",
      providerConfigKey: "slack-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: {
        ok: true,
        ts: "1713220123.001100",
        channel: "C0CUSTSUCCESS",
      },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_slack_post/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_slack_post", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_slack_post",
      workspaceId: WORKSPACE_ID,
      path: "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json",
      revision: "rev_slack_post",
      correlationId: "corr_slack_post",
      content: JSON.stringify({ text: "Posting from the bridge" }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "slack");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "post_message");
    assert.equal(result.metadata?.externalId, "1713220123.001100");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "POST");
    // Adapter emits /api/chat.postMessage; bridge strips /api before proxying
    // because the cloud's Slack-via-Nango convention prepends /api itself.
    // Without the strip, mock-nango forwards /api/api/chat.postMessage → 404.
    assert.equal(call.endpoint, "/chat.postMessage");
    assert.equal(call.connectionId, "conn_slack_post");

    assert.equal(ackCalls.length, 1);
    assert.deepEqual(ackCalls[0].body, {
      success: true,
      providerResult: {
        provider: "slack",
        action: "post_message",
        method: "POST",
        endpoint: "/chat.postMessage",
        status: 200,
        externalId: "1713220123.001100",
      },
    });
  });

  it("derives Slack reactions.add externalId from the request timestamp, not the response", async () => {
    // CodeRabbit on PR #470: chat.postMessage returns `{ ok: true, ts }` but
    // reactions.add returns just `{ ok: true }` with no `ts`. Reading the
    // response only would leave reaction writebacks with no externalId. The
    // target message's timestamp lives on the REQUEST body (`timestamp`
    // field per chat.postMessage / reactions.add docs). The bridge must
    // surface that so writeback metadata still pins the affected message.
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn_slack_reaction",
      providerConfigKey: "slack-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    await bindNangoMock(() => ({
      status: 200,
      // reactions.add success body: just { ok: true }, no ts.
      body: { ok: true },
    }));

    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_slack_reaction/ack")) {
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_slack_reaction", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_slack_reaction",
      workspaceId: WORKSPACE_ID,
      // path-mapper encodes message ts with `.` → `_` in the segment, so the
      // adapter unpacks it to the canonical `1713220123.001100` form on
      // request.body.timestamp; that's what we expect to be surfaced.
      path: "/slack/channels/customer-success--C0CUSTSUCCESS/messages/1713220123_001100/reactions/add reaction.json",
      revision: "rev_slack_reaction",
      correlationId: "corr_slack_reaction",
      content: JSON.stringify({ name: "thumbsup" }),
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.metadata?.action, "add_reaction");
    // Critical: externalId comes from the request body's timestamp, not the
    // (empty) response body.
    assert.equal(result.metadata?.externalId, "1713220123.001100");
  });

  it("treats Slack ok:false on a 200 as permanent_failure with the slack error message", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn_slack_fail",
      providerConfigKey: "slack-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    // Slack returns 200 with `{ ok: false, error: "<reason>" }` for
    // business-level rejections (channel_not_found, missing_scope, etc.).
    // The bridge must NOT ACK these as success.
    await bindNangoMock(() => ({
      status: 200,
      body: { ok: false, error: "channel_not_found" },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_slack_okfalse/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_slack_okfalse", success: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_slack_okfalse",
      workspaceId: WORKSPACE_ID,
      path: "/slack/channels/missing/messages/create request.json",
      revision: "rev_slack_fail",
      correlationId: "corr_slack_fail",
      content: JSON.stringify({ text: "to a missing channel" }),
    });

    assert.equal(result.outcome, "permanent_failure");
    assert.equal(result.provider, "slack");
    assert.equal(result.relayfileAcked, true);

    assert.equal(ackCalls.length, 1);
    assert.match(String(ackCalls[0].body.error), /channel_not_found/i);
  });

  // Slack uses both `ratelimited` (older Web API) and `rate_limited` (newer
  // surfaces and the docker mock-slack default at
  // docker/e2e/mock-slack/server.js:138). Both must be treated as
  // retryable, otherwise transient throttling silently ACKs as success/permanent
  // and the writeback never gets retried.
  for (const errorSpelling of ["ratelimited", "rate_limited"] as const) {
    it(`treats Slack ${errorSpelling} body error as retryable_failure without acking`, async () => {
      const db = await createRelayfileWritebackPgliteDb();
      cleanupDb = db.cleanup;
      db.installAsAppDb();
      await db.insertWorkspaceIntegration({
        workspaceId: WORKSPACE_ID,
        provider: "slack",
        connectionId: `conn_slack_${errorSpelling}`,
        providerConfigKey: "slack-relay",
        createdAt: BASE_TIMESTAMP,
        updatedAt: BASE_TIMESTAMP,
      });

      await bindNangoMock(() => ({
        status: 200,
        body: { ok: false, error: errorSpelling },
      }));

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        throw new Error(`Unexpected fetch ${url}`);
      }) as typeof fetch;

      const { handleRelayfileProviderWriteback } = await loadBridgeModule();
      const result = await handleRelayfileProviderWriteback({
        opId: `op_slack_${errorSpelling}`,
        workspaceId: WORKSPACE_ID,
        path: "/slack/channels/customer-success--C0CUSTSUCCESS/messages/create request.json",
        revision: `rev_slack_${errorSpelling}`,
        correlationId: `corr_slack_${errorSpelling}`,
        content: JSON.stringify({ text: "throttled" }),
      });

      assert.equal(result.outcome, "retryable_failure");
      assert.equal(result.provider, "slack");
      assert.equal(result.relayfileAcked, false);
    });
  }

  it("submits Linear issueCreate via the Nango GraphQL proxy and acknowledges success", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn_linear_123",
      providerConfigKey: "linear-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-uuid-1",
              identifier: "LIN-99",
              url: "https://linear.app/x/issue/LIN-99",
            },
          },
        },
      },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_linear_create/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_linear_create", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_linear_create",
      workspaceId: WORKSPACE_ID,
      path: "/linear/issues/create request.json",
      revision: "rev_linear_1",
      correlationId: "corr_linear_create",
      content: JSON.stringify({
        teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
        title: "Bridge integration smoke test",
        description: "Created from the writeback bridge test",
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "linear");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "create_issue");
    assert.equal(result.metadata?.externalId, "issue-uuid-1");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "POST");
    assert.equal(call.endpoint, "/graphql");
    assert.equal(call.connectionId, "conn_linear_123");
    assert.equal(call.providerConfigKey, "linear-relay");

    assert.equal(ackCalls.length, 1);
    assert.deepEqual(ackCalls[0].body, {
      success: true,
      providerResult: {
        provider: "linear",
        action: "create_issue",
        method: "POST",
        endpoint: "/graphql",
        status: 200,
        externalId: "issue-uuid-1",
      },
    });
  });

  it("treats Linear mutation success: false on a 200 as permanent_failure even without GraphQL errors", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn_linear_789",
      providerConfigKey: "linear-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    // Linear can return 200 with the mutation payload reporting success:false
    // and no top-level `errors` array (e.g. team mismatch, scope rejection).
    // The bridge must NOT ACK these as success.
    await bindNangoMock(() => ({
      status: 200,
      body: {
        data: {
          issueCreate: {
            success: false,
            issue: null,
          },
        },
      },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_linear_unsuccessful/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_linear_unsuccessful", success: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_linear_unsuccessful",
      workspaceId: WORKSPACE_ID,
      path: "/linear/issues/create request.json",
      revision: "rev_linear_unsuccessful",
      correlationId: "corr_linear_unsuccessful",
      content: JSON.stringify({
        teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
        title: "Will be quietly rejected",
      }),
    });

    assert.equal(result.outcome, "permanent_failure");
    assert.equal(result.provider, "linear");
    assert.equal(result.relayfileAcked, true);

    assert.equal(ackCalls.length, 1);
    assert.equal(ackCalls[0].body.success, false);
    assert.match(String(ackCalls[0].body.error), /success: false/i);
  });

  it("treats Linear GraphQL errors on a 200 as permanent_failure with the schema message", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn_linear_456",
      providerConfigKey: "linear-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    await bindNangoMock(() => ({
      status: 200,
      body: {
        errors: [{ message: "Argument 'input' has invalid value: missing teamId" }],
      },
    }));

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_linear_schema/ack")) {
        ackCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_linear_schema", success: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_linear_schema",
      workspaceId: WORKSPACE_ID,
      path: "/linear/issues/create request.json",
      revision: "rev_linear_2",
      correlationId: "corr_linear_schema",
      content: JSON.stringify({
        teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
        title: "Will be rejected",
      }),
    });

    assert.equal(result.outcome, "permanent_failure");
    assert.equal(result.provider, "linear");
    assert.equal(result.relayfileAcked, true);

    assert.equal(ackCalls.length, 1);
    assert.match(String(ackCalls[0].body.error), /missing teamId/i);
  });

  it("submits Linear issueDelete for file_delete writebacks", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn_linear_delete",
      providerConfigKey: "linear-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: {
        data: {
          issueDelete: {
            success: true,
          },
        },
      },
    }));

    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_linear_delete/ack")) {
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_linear_delete", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_linear_delete",
      workspaceId: WORKSPACE_ID,
      path: "/linear/issues/11111111-1111-4111-8111-111111111111.json",
      revision: "rev_linear_delete",
      correlationId: "corr_linear_delete",
      action: "file_delete",
      content: "",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "linear");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "delete_issue");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "POST");
    assert.equal(call.endpoint, "/graphql");
    assert.equal(call.connectionId, "conn_linear_delete");
  });

  it("submits Slack chat.delete for file_delete writebacks", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn_slack_delete",
      providerConfigKey: "slack-relay",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 200,
      body: { ok: true, ts: "1713220123.001100" },
    }));

    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/writeback/op_slack_delete/ack")) {
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_slack_delete", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_slack_delete",
      workspaceId: WORKSPACE_ID,
      path: "/slack/channels/customer-success--C0CUSTSUCCESS/messages/1713220123_001100.json",
      revision: "rev_slack_delete",
      correlationId: "corr_slack_delete",
      action: "file_delete",
      content: "",
    });

    assert.equal(result.outcome, "success");
    assert.equal(result.provider, "slack");
    assert.equal(result.relayfileAcked, true);
    assert.equal(result.metadata?.action, "delete_message");
    assert.equal(result.metadata?.externalId, "1713220123.001100");

    assert.equal(nango.capturedRequests.length, 1);
    const call = nango.capturedRequests[0];
    assert.equal(call.method, "POST");
    assert.equal(call.endpoint, "/chat.delete");
    assert.equal(call.connectionId, "conn_slack_delete");
  });

  it("fails the operation when the workspace integration is missing", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();

    const nango = await bindNangoMock(() => {
      throw new Error("Nango should not be called when integration is missing");
    });

    const ackCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = stubRelayAuthFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.endsWith("/writeback/op_missing_integration/ack")) {
        ackCalls.push({ url, body });
        return new Response(
          JSON.stringify({ status: "acknowledged", id: "op_missing_integration", success: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_missing_integration",
      workspaceId: WORKSPACE_ID,
      path: "/notion/pages/page-404.json",
      revision: "rev_missing",
      correlationId: "corr_missing_integration",
      content: JSON.stringify({
        properties: {
          Name: { id: "title", type: "title", value: "Should not find integration" },
        },
      }),
    });

    assert.equal(result.outcome, "permanent_failure");
    assert.equal(result.provider, "notion");
    assert.equal(result.relayfileAcked, true);

    assert.equal(nango.capturedRequests.length, 0);
    assert.equal(ackCalls.length, 1);
    assert.match(ackCalls[0].url, /\/writeback\/op_missing_integration\/ack$/);
    assert.equal(ackCalls[0].body.success, false);
    assert.match(String(ackCalls[0].body.error), /integration/i);
  });

  it("returns a retryable failure when the provider proxy is unavailable and does not ACK", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_retry",
      providerConfigKey: "notion-sage",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    });

    const nango = await bindNangoMock(() => ({
      status: 502,
      body: { message: "upstream temporarily unavailable" },
    }));

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const { handleRelayfileProviderWriteback } = await loadBridgeModule();
    const result = await handleRelayfileProviderWriteback({
      opId: "op_retryable_notion",
      workspaceId: WORKSPACE_ID,
      path: "/notion/pages/22222222-2222-4222-8222-222222222222.json",
      revision: "rev_retry",
      correlationId: "corr_retry",
      content: JSON.stringify({
        properties: {
          Name: { id: "title", type: "title", value: "Retry me" },
        },
      }),
      contentType: "application/json",
      encoding: "utf-8",
    });

    assert.equal(result.outcome, "retryable_failure");
    assert.equal(result.provider, "notion");
    assert.equal(result.relayfileAcked, false);
    assert.equal(result.metadata?.status, 502);
    assert.equal(nango.capturedRequests.length, 1);
    assert.equal(nango.capturedRequests[0].method, "PATCH");
    assert.equal(nango.capturedRequests[0].endpoint, "/v1/pages/22222222-2222-4222-8222-222222222222");
  });
});
