import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveWritebackRequest } from "@relayfile/adapter-notion";
import { Resource } from "sst";

import { createRelayfileWritebackPgliteDb } from "./helpers/relayfile-writeback-pglite-db.ts";
import { startMockNangoSdkServer } from "./helpers/mock-nango-sdk-server.ts";
import { startMockNotion } from "./helpers/mock-notion-server.ts";

type DurableObjectId = string;
type DurableObjectStub = {
  fetch: (request: Request) => Promise<Response>;
};
type DurableObjectNamespace = {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId) => DurableObjectStub;
};
type MessageBatch = {
  queue: string;
  messages: WritebackQueueMessageStub[];
  ackAll: () => void;
  retryAll: () => void;
};

type WritebackTask = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
};

type BridgeInput = WritebackTask & {
  provider?: string;
  content: string;
  contentType?: string;
  encoding?: string;
};

type RouteModule = {
  POST: (request: Request) => Promise<Response>;
};

type ProviderExecutorModule = {
  executeProviderWriteback: (
    task: WritebackTask,
    env: {
      WORKSPACE_DO: DurableObjectNamespace;
      RELAYFILE_WRITEBACK_BRIDGE_URL?: string;
      INTERNAL_HMAC_SECRET: string;
    },
    options?: {
      bridgeUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    },
  ) => Promise<void>;
};

type QueueConsumerModule = {
  default: {
    queue: (batch: MessageBatch, env: {
      WORKSPACE_DO: DurableObjectNamespace;
      RELAYFILE_WRITEBACK_BRIDGE_URL?: string;
      INTERNAL_HMAC_SECRET: string;
    }) => Promise<void>;
  };
};

type WritebackQueueMessageStub = {
  body: WritebackTask;
  attempts: number;
  ack: () => void;
  retry: () => void;
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const BRIDGE_URL = "https://cloud.test/api/internal/relayfile/writeback";

function signRelayfileInternalRequest(
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest("hex");
}

async function loadRoute(): Promise<RouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/internal/relayfile/writeback/route.ts",
      import.meta.url,
    ).href
  ) as Promise<RouteModule>;
}

async function loadBatchRoute(): Promise<RouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/internal/relayfile/writeback/batch/route.ts",
      import.meta.url,
    ).href
  ) as Promise<RouteModule>;
}

async function loadProviderExecutor(): Promise<ProviderExecutorModule> {
  return import(
    new URL(
      "../packages/relayfile/src/writeback/provider-executor.ts",
      import.meta.url,
    ).href
  ) as Promise<ProviderExecutorModule>;
}

async function loadQueueConsumer(): Promise<QueueConsumerModule> {
  return import(
    new URL(
      "../packages/relayfile/src/queue-consumer.ts",
      import.meta.url,
    ).href
  ) as Promise<QueueConsumerModule>;
}

function createWritebackQueueBatch(task: WritebackTask) {
  const messages: WritebackQueueMessageStub[] = [
    {
      body: task,
      attempts: 1,
      ack: () => {},
      retry: () => {},
    },
  ];

  return {
    queue: "relayfile-writeback",
    messages,
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as MessageBatch;
}

function createWorkspaceNamespace(content: string) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  return {
    calls,
    namespace: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const body = request.method === "POST"
              ? (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
              : {};
            calls.push({ url: url.pathname, body });

            return new Response(
              JSON.stringify({
                path: "/notion/databases/db-1/pages/page-1.json",
                revision: "rev_e2e",
                contentType: "application/json",
                content,
                encoding: "utf-8",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          },
        } as DurableObjectStub;
      },
    } as DurableObjectNamespace,
  };
}

function createProviderExecutorWorkspaceNamespace(input: {
  task: WritebackTask;
  content: string;
  contentType: string;
  provider: string;
}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  return {
    calls,
    namespace: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const body = request.method === "POST"
              ? (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
              : {};
            calls.push({ url: url.pathname, body });

            if (url.pathname === "/internal/writeback-context") {
              return new Response(
                JSON.stringify({
                  workspaceId: input.task.workspaceId,
                  operation: {
                    opId: input.task.opId,
                    path: input.task.path,
                    revision: input.task.revision,
                    action: "file_upsert",
                    provider: input.provider,
                    status: "pending",
                    correlationId: input.task.correlationId,
                  },
                  file: {
                    path: input.task.path,
                    revision: input.task.revision,
                    contentType: input.contentType,
                    content: input.content,
                    encoding: "utf-8",
                  },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }

            return new Response(
              JSON.stringify({ error: `Unexpected WorkspaceDO request ${url.pathname}` }),
              { status: 404, headers: { "Content-Type": "application/json" } },
            );
          },
        } as DurableObjectStub;
      },
    } as DurableObjectNamespace,
  };
}

async function dispatchWritebackThroughRoute(
  task: WritebackTask,
  namespace: DurableObjectNamespace,
  routePost: RouteModule["POST"],
): Promise<Response> {
  const id = namespace.idFromName(task.workspaceId);
  const stub = namespace.get(id);
  const fileResponse = await stub.fetch(
    new Request("https://workspace-do/read-file", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": task.workspaceId,
        "X-Correlation-Id": task.correlationId,
      },
      body: JSON.stringify({
        path: task.path,
      }),
    }),
  );

  assert.equal(fileResponse.ok, true);
  const file = (await fileResponse.json()) as {
    content: string;
    contentType?: string;
    encoding?: string;
  };
  const rawBody = JSON.stringify({
    ...task,
    content: file.content,
    contentType: file.contentType,
    encoding: file.encoding,
  } satisfies BridgeInput);
  const timestamp = new Date().toISOString();
  const signature = signRelayfileInternalRequest(
    timestamp,
    rawBody,
    "relayfile-internal-secret",
  );

  return routePost(
    new Request("https://cloud.test/api/internal/relayfile/writeback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": signature,
      },
      body: rawBody,
    }),
  );
}

const NANGO_SECRET = "nango-secret-for-tests";
const RELAYAUTH_URL = "https://relayauth.test";
const RELAYAUTH_API_KEY = "relayauth-api-key-for-tests";

describe("relayfile provider writeback end-to-end", () => {
  let cleanupDb: (() => Promise<void>) | undefined;
  let originalFetch: typeof fetch | undefined;
  let nangoServer: Awaited<ReturnType<typeof startMockNangoSdkServer>> | undefined;
  let notionServer: Awaited<ReturnType<typeof startMockNotion>> | undefined;

  async function resetNangoClient(): Promise<void> {
    const mod = await import(
      new URL(
        "../packages/web/lib/integrations/nango-service.ts",
        import.meta.url,
      ).href
    );
    mod.resetNangoClientForTests();
  }

  beforeEach(async () => {
    process.env.NANGO_SECRET_KEY = NANGO_SECRET;
    process.env.RELAYFILE_URL = "https://relayfile.test";
    process.env.RELAY_JWT_SECRET = "relay-jwt-secret-for-tests";
    process.env.RELAYFILE_INTERNAL_HMAC_SECRET = "relayfile-internal-secret";
    process.env.RELAYAUTH_URL = RELAYAUTH_URL;
    process.env.RELAYAUTH_API_KEY = RELAYAUTH_API_KEY;

    (Resource as unknown as Record<string, unknown>).NangoSecretKey = {
      value: NANGO_SECRET,
    };
    (Resource as unknown as Record<string, unknown>).RelayJwtSecret = {
      value: "relay-jwt-secret-for-tests",
    };
    (Resource as unknown as Record<string, unknown>).RelayfileInternalHmacSecret = {
      value: "relayfile-internal-secret",
    };

    originalFetch = globalThis.fetch;
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
    if (notionServer) {
      await notionServer.stop();
      notionServer = undefined;
    }

    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }

    delete process.env.NANGO_HOST;
    delete process.env.NANGO_SECRET_KEY;
    delete process.env.RELAYFILE_URL;
    delete process.env.RELAY_JWT_SECRET;
    delete process.env.RELAYFILE_INTERNAL_HMAC_SECRET;
    delete process.env.RELAYAUTH_URL;
    delete process.env.RELAYAUTH_API_KEY;
    await resetNangoClient();
  });

  it("rejects requests with an invalid internal writeback signature", async () => {
    const { POST } = await loadRoute();
    const rawBody = JSON.stringify({
      opId: "op_invalid_signature",
      workspaceId: WORKSPACE_ID,
      path: "/notion/pages/page-invalid.json",
      revision: "rev_invalid",
      correlationId: "corr_invalid_signature",
      content: "{}",
    } satisfies BridgeInput);
    const timestamp = new Date().toISOString();

    const response = await POST(
      new Request("https://cloud.test/api/internal/relayfile/writeback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signRelayfileInternalRequest(
            timestamp,
            "{\"tampered\":true}",
            "relayfile-internal-secret",
          ),
        },
        body: rawBody,
      }),
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Unauthorized",
    });
  });

  it("returns retryable dispatch_moved from the batch bridge when cloud dispatch has moved to Cloudflare", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_cf",
      providerConfigKey: "notion-sage",
      writebackDispatchVia: "cf",
    });
    const { POST } = await loadBatchRoute();
    const rawBody = JSON.stringify({
      items: [
        {
          opId: "op_dispatch_moved",
          workspaceId: WORKSPACE_ID,
          path: "notion/databases/db-1/pages/page-1.json",
          revision: "rev_dispatch_moved",
          correlationId: "corr_dispatch_moved",
          content: "{}",
        },
      ],
    });
    const timestamp = new Date().toISOString();

    const response = await POST(
      new Request("https://cloud.test/api/internal/relayfile/writeback/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signRelayfileInternalRequest(
            timestamp,
            rawBody,
            "relayfile-internal-secret",
          ),
        },
        body: rawBody,
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      results: [
        {
          opId: "op_dispatch_moved",
          outcome: "retryable_failure",
          provider: "notion",
          error: {
            code: "dispatch_moved",
            message: "Relayfile writeback dispatch moved to Cloudflare",
          },
          relayfileAcked: false,
        },
      ],
    });
  });

  it("runs the real writeback flow from RelayFile task to provider request to RelayFile ACK", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_123",
      providerConfigKey: "notion-sage",
    });

    const task = {
      opId: "op_e2e_notion",
      workspaceId: WORKSPACE_ID,
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_e2e",
      correlationId: "corr_e2e_notion",
    } satisfies WritebackTask;
    const pageContent = JSON.stringify({
      properties: {
        Name: {
          id: "title",
          type: "title",
          value: "Updated by end-to-end test",
        },
      },
    });
    const { namespace, calls: workspaceCalls } = createWorkspaceNamespace(
      pageContent,
    );
    nangoServer = await startMockNangoSdkServer({
      secret: NANGO_SECRET,
      respond: () => ({ status: 200, body: { id: "page-1" } }),
    });
    process.env.NANGO_HOST = nangoServer.url;
    await resetNangoClient();

    const ackRequests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const { POST } = await loadRoute();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === `${RELAYAUTH_URL}/v1/identities`) {
        return new Response(JSON.stringify({ id: "identity-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `${RELAYAUTH_URL}/v1/tokens`) {
        return new Response(
          JSON.stringify({ accessToken: "relayfile-token-1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/writeback/op_e2e_notion/ack")) {
        ackRequests.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            status: "acknowledged",
            id: "op_e2e_notion",
            success: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    const response = await dispatchWritebackThroughRoute(
      task,
      namespace,
      POST,
    );
    assert.equal(response.status, 200);
    const routeBody = await response.json() as Record<string, unknown>;
    assert.equal(routeBody.outcome, "success");
    assert.equal(routeBody.relayfileAcked, true);

    assert.equal(workspaceCalls.length, 1);
    assert.equal(ackRequests.length, 1);
    assert.equal(nangoServer.capturedRequests.length, 1);

    const planned = resolveWritebackRequest(task.path, pageContent);
    const proxyRequest = nangoServer.capturedRequests[0];
    assert.equal(proxyRequest.connectionId, "conn_notion_123");
    assert.equal(proxyRequest.providerConfigKey, "notion-sage");
    assert.equal(proxyRequest.method, planned.method);
    assert.equal(proxyRequest.endpoint, planned.endpoint);
    assert.deepEqual(
      proxyRequest.body,
      JSON.parse(JSON.stringify(planned.body)) as Record<string, unknown>,
    );

    assert.match(ackRequests[0]?.url, /\/writeback\/op_e2e_notion\/ack$/);
    assert.deepEqual(ackRequests[0]?.body, {
      success: true,
      providerResult: {
        provider: "notion",
        action: "create_page",
        method: "POST",
        endpoint: "/v1/pages",
        status: 200,
        externalId: "page-1",
      },
    });
  });

  it("PATCHes Notion markdown content through the provider executor", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_markdown",
      providerConfigKey: "notion-sage",
    });

    notionServer = await startMockNotion();
    const fetchNotion = originalFetch ?? globalThis.fetch;
    nangoServer = await startMockNangoSdkServer({
      secret: NANGO_SECRET,
      respond: async (request) => {
        const response = await fetchNotion(
          `${notionServer?.baseUrl}${request.endpoint}`,
          {
            method: request.method,
            headers: {
              "Content-Type": "application/json",
              ...(request.query.notionVersion
                ? { "Notion-Version": request.query.notionVersion }
                : {}),
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
          },
        );
        const body = await response.json().catch(() => null) as unknown;
        return { status: response.status, body };
      },
    });
    process.env.NANGO_HOST = nangoServer.url;
    await resetNangoClient();

    const pageId = "11111111-1111-4111-8111-111111111112";
    const markdown = "# Updated from RelayFile\n\nThis markdown must reach Notion.";
    const task = {
      opId: "op_e2e_notion_markdown",
      workspaceId: WORKSPACE_ID,
      path: `/notion/databases/db-1/pages/${pageId}/content.md`,
      revision: "rev_markdown",
      correlationId: "corr_e2e_notion_markdown",
    } satisfies WritebackTask;
    const { namespace, calls: workspaceCalls } =
      createProviderExecutorWorkspaceNamespace({
        task,
        content: markdown,
        contentType: "text/markdown",
        provider: "notion",
      });
    const ackRequests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const { POST } = await loadRoute();
    const { executeProviderWriteback } = await loadProviderExecutor();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === `${RELAYAUTH_URL}/v1/identities`) {
        return new Response(JSON.stringify({ id: "identity-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `${RELAYAUTH_URL}/v1/tokens`) {
        return new Response(
          JSON.stringify({ accessToken: "relayfile-token-1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/writeback/op_e2e_notion_markdown/ack")) {
        ackRequests.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            status: "acknowledged",
            id: "op_e2e_notion_markdown",
            success: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch ${url}`);
    }) as typeof fetch;

    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        RELAYFILE_WRITEBACK_BRIDGE_URL: BRIDGE_URL,
        INTERNAL_HMAC_SECRET: "relayfile-internal-secret",
      },
      {
        bridgeUrl: BRIDGE_URL,
        fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          assert.equal(url, BRIDGE_URL);
          return POST(new Request(url, init));
        }) as typeof fetch,
      },
    );

    assert.equal(workspaceCalls.length, 2);
    assert.equal(ackRequests.length, 1);
    assert.equal(notionServer.recorded.length, 1);

    const notionRequest = notionServer.recorded[0];
    assert.equal(notionRequest.method, "PATCH");
    assert.equal(notionRequest.path, `/v1/pages/${pageId}/markdown`);
    assert.match(notionRequest.body, /Updated from RelayFile/);
    assert.match(notionRequest.body, /This markdown must reach Notion\./);
  });

  it("PATCHes Notion markdown content when a writeback queue message is consumed", async () => {
    const db = await createRelayfileWritebackPgliteDb();
    cleanupDb = db.cleanup;
    db.installAsAppDb();
    await db.insertWorkspaceIntegration({
      workspaceId: WORKSPACE_ID,
      provider: "notion",
      connectionId: "conn_notion_queue_markdown",
      providerConfigKey: "notion-sage",
    });

    notionServer = await startMockNotion();
    const fetchNetwork = originalFetch ?? globalThis.fetch;
    nangoServer = await startMockNangoSdkServer({
      secret: NANGO_SECRET,
      respond: async (request) => {
        const response = await fetchNetwork(
          `${notionServer?.baseUrl}${request.endpoint}`,
          {
            method: request.method,
            headers: {
              "Content-Type": "application/json",
              ...(request.query.notionVersion
                ? { "Notion-Version": request.query.notionVersion }
                : {}),
            },
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
          },
        );
        const body = await response.json().catch(() => null) as unknown;
        return { status: response.status, body };
      },
    });
    process.env.NANGO_HOST = nangoServer.url;
    await resetNangoClient();

    const pageId = "11111111-1111-4111-8111-111111111113";
    const markdown = "# Queued RelayFile update\n\nThis body came from the queue.";
    const task = {
      opId: "op_e2e_notion_queue_markdown",
      workspaceId: WORKSPACE_ID,
      path: `/notion/databases/db-1/pages/${pageId}/content.md`,
      revision: "rev_queue_markdown",
      correlationId: "corr_e2e_notion_queue_markdown",
    } satisfies WritebackTask;
    const { namespace } = createProviderExecutorWorkspaceNamespace({
      task,
      content: markdown,
      contentType: "text/markdown",
      provider: "notion",
    });
    const ackRequests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const { POST } = await loadRoute();
    const { POST: batchPOST } = await loadBatchRoute();
    const consumer = await loadQueueConsumer();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === BRIDGE_URL) {
        return POST(new Request(url, init));
      }
      if (url === `${BRIDGE_URL}/batch`) {
        return batchPOST(new Request(url, init));
      }

      if (url === `${RELAYAUTH_URL}/v1/identities`) {
        return new Response(JSON.stringify({ id: "identity-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `${RELAYAUTH_URL}/v1/tokens`) {
        return new Response(
          JSON.stringify({ accessToken: "relayfile-token-1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.endsWith("/writeback/op_e2e_notion_queue_markdown/ack")) {
        ackRequests.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            status: "acknowledged",
            id: "op_e2e_notion_queue_markdown",
            success: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return fetchNetwork(input, init);
    }) as typeof fetch;

    await consumer.default.queue(
      createWritebackQueueBatch(task),
      {
        WORKSPACE_DO: namespace,
        RELAYFILE_WRITEBACK_BRIDGE_URL: BRIDGE_URL,
        INTERNAL_HMAC_SECRET: "relayfile-internal-secret",
      },
    );

    assert.equal(ackRequests.length, 1);
    assert.equal(notionServer.recorded.length, 1);

    const notionRequest = notionServer.recorded[0];
    assert.equal(notionRequest.method, "PATCH");
    assert.equal(notionRequest.path, `/v1/pages/${pageId}/markdown`);
    assert.match(notionRequest.body, /Queued RelayFile update/);
    assert.match(notionRequest.body, /This body came from the queue\./);
  });
});
