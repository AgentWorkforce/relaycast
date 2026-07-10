import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NANGO_RESPONSE_BODY_BYTES,
  nangoProxy,
} from "../src/writeback/nango.js";

type WritebackTask = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
};

type ExecutorModule = {
  executeProviderWriteback: (
    task: WritebackTask,
    env: {
      WORKSPACE_DO: DurableObjectNamespace;
      RELAYFILE_WRITEBACK_BRIDGE_URL?: string;
      INTERNAL_HMAC_SECRET: string;
      NANGO_SECRET_KEY?: string;
      NANGO_BASE_URL?: string;
      AUDIT_QUEUE?: Queue;
    },
    options?: {
      bridgeUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    },
  ) => Promise<void>;
  executeProviderWritebackBatch: (
    tasks: WritebackTask[],
    env: {
      WORKSPACE_DO: DurableObjectNamespace;
      RELAYFILE_WRITEBACK_BRIDGE_URL?: string;
      INTERNAL_HMAC_SECRET: string;
      NANGO_SECRET_KEY?: string;
      NANGO_BASE_URL?: string;
      AUDIT_QUEUE?: Queue;
    },
    options?: {
      bridgeUrl?: string;
      fetchImpl?: typeof fetch;
      now?: () => Date;
    },
  ) => Promise<
    Array<{ task: WritebackTask; success: boolean; error?: string }>
  >;
};

type OperationContext = {
  opId: string;
  path: string;
  revision: string;
  action: "file_upsert" | "file_delete";
  provider: string;
  status: string;
  correlationId: string;
};

function createWorkspaceNamespace(input: {
  workspaceId: string;
  operation: OperationContext;
  file?: {
    path: string;
    revision: string;
    content: string | null;
    contentType?: string;
    encoding?: string;
    contentInline?: boolean;
    streamedContent?: Uint8Array | string;
    streamedContentLength?: string;
  } | null;
  integration?: {
    provider: string;
    providerConfigKey: string;
    connectionId: string;
    aliasFields?: Record<string, unknown>;
    writebackDispatchVia: "bridge" | "cf";
    updatedAt?: string;
  };
}) {
  const requests: Request[] = [];
  const ackBodies: Record<string, unknown>[] = [];

  return {
    requests,
    ackBodies,
    namespace: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          fetch: async (request: Request) => {
            requests.push(request);
            const url = new URL(request.url);

            if (url.pathname === "/internal/writeback-context") {
              return new Response(
                JSON.stringify({
                  workspaceId: input.workspaceId,
                  operation: input.operation,
                  file: input.file
                    ? {
                        path: input.file.path,
                        revision: input.file.revision,
                        contentType:
                          input.file.contentType ?? "application/json",
                        content: input.file.content,
                        encoding: input.file.encoding ?? "utf-8",
                      }
                    : null,
                  ...(input.file?.contentInline === false
                    ? { contentInline: false }
                    : {}),
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            if (url.pathname === "/internal/writeback-content" && input.file) {
              const body =
                typeof input.file.streamedContent === "string"
                  ? new TextEncoder().encode(input.file.streamedContent)
                  : (input.file.streamedContent ?? new Uint8Array());
              return new Response(Uint8Array.from(body), {
                status: 200,
                headers: {
                  "X-Relayfile-Encoding": input.file.encoding ?? "utf-8",
                  "X-Relayfile-Revision": input.file.revision,
                  ...(input.file.streamedContentLength
                    ? { "Content-Length": input.file.streamedContentLength }
                    : {}),
                },
              });
            }

            if (
              url.pathname ===
              `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/writeback/${encodeURIComponent(input.operation.opId)}/ack`
            ) {
              ackBodies.push(
                (await request
                  .clone()
                  .json()
                  .catch(() => ({}))) as Record<string, unknown>,
              );
              return new Response(
                JSON.stringify({
                  status: "acknowledged",
                  id: input.operation.opId,
                  success: false,
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            if (
              input.integration &&
              url.pathname ===
                `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/${encodeURIComponent(input.integration.provider)}`
            ) {
              return new Response(
                JSON.stringify({
                  provider: input.integration.provider,
                  providerConfigKey: input.integration.providerConfigKey,
                  connectionId: input.integration.connectionId,
                  aliasFields: input.integration.aliasFields ?? {},
                  writebackDispatchVia: input.integration.writebackDispatchVia,
                  updatedAt:
                    input.integration.updatedAt ?? "2026-05-14T00:00:00.000Z",
                }),
                {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            if (
              url.pathname.startsWith(
                `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/integrations/`,
              )
            ) {
              return new Response(
                JSON.stringify({
                  code: "not_found",
                  message: "integration not found",
                }),
                {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            throw new Error(`Unexpected WorkspaceDO request ${url.pathname}`);
          },
        } as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
  };
}

async function loadExecutor(): Promise<ExecutorModule> {
  return import(
    new URL("../src/writeback/provider-executor.js", import.meta.url).href
  ) as Promise<ExecutorModule>;
}

describe("nango proxy response buffering", () => {
  const credential = {
    provider: "notion",
    providerConfigKey: "notion-sage",
    connectionId: "conn_notion",
    aliasFields: {},
    writebackDispatchVia: "cf",
    updatedAt: "2026-05-27T00:00:00.000Z",
  } as const;

  it("preserves normal-size JSON response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "page-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const response = await nangoProxy(
      credential,
      { method: "GET", endpoint: "/v1/pages/page-1" },
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(response.data).toEqual({ id: "page-1" });
  });

  it("truncates oversized non-JSON response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        `${"x".repeat(MAX_NANGO_RESPONSE_BODY_BYTES)}diagnostic-tail`,
        {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        },
      );
    });

    const response = await nangoProxy<string>(
      credential,
      { method: "GET", endpoint: "/v1/pages/page-1" },
      {
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(response.data).toHaveLength(MAX_NANGO_RESPONSE_BODY_BYTES);
    expect(response.data).not.toContain("diagnostic-tail");
  });

  it("fails oversized JSON response bodies with a bounded error", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        `{"message":"${"x".repeat(MAX_NANGO_RESPONSE_BODY_BYTES)}"}`,
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    await expect(
      nangoProxy(
        credential,
        { method: "GET", endpoint: "/v1/pages/page-1" },
        {
          NANGO_SECRET_KEY: "nango-secret",
          NANGO_BASE_URL: "https://api.nango.test",
        },
        { fetchImpl: fetchImpl as typeof fetch },
      ),
    ).rejects.toThrow(
      `Nango proxy response body exceeded ${MAX_NANGO_RESPONSE_BODY_BYTES} bytes`,
    );
  });
});

describe("provider writeback executor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a Notion page file from WorkspaceDO and posts the bridge request", async () => {
    const task = {
      opId: "op_notion_page",
      workspaceId: "ws_notion_page",
      path: "/notion/databases/db-1/pages/11111111-1111-4111-8111-111111111112.json",
      revision: "rev_notion_page",
      correlationId: "corr_notion_page",
    } satisfies WritebackTask;
    const pageJson = JSON.stringify({
      properties: {
        Name: {
          id: "title",
          type: "title",
          value: "Updated from queue consumer",
        },
      },
    });
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: pageJson,
      },
    });
    const bridgeCalls: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const fixedTimestamp = "2026-04-17T09:00:00.000Z";
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        bridgeCalls.push({
          url: String(input),
          headers,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >,
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
        now: () => new Date(fixedTimestamp),
      },
    );

    const expectedBody = {
      opId: task.opId,
      workspaceId: task.workspaceId,
      path: task.path,
      revision: task.revision,
      correlationId: task.correlationId,
      provider: "notion",
      action: "file_upsert",
      content: pageJson,
      contentType: "application/json",
      encoding: "utf-8",
    };
    const expectedSignature = createHmac("sha256", "test-internal-secret")
      .update(`${fixedTimestamp}\n${JSON.stringify(expectedBody)}`)
      .digest("hex");

    expect(requests).toHaveLength(2);
    expect(ackBodies).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bridgeCalls[0]).toEqual({
      url: "https://cloud.test/cloud/api/internal/relayfile/writeback",
      headers: expect.any(Headers),
      body: expectedBody,
    });
    expect(bridgeCalls[0]?.headers.get("x-relay-timestamp")).toBe(
      fixedTimestamp,
    );
    expect(bridgeCalls[0]?.headers.get("x-relay-signature")).toBe(
      expectedSignature,
    );
  });

  it("hydrates elided utf-8 writeback content before posting to the bridge", async () => {
    const task = {
      opId: "op_elided_utf8",
      workspaceId: "ws_elided_utf8",
      path: "/notion/pages/page.json",
      revision: "rev_elided_utf8",
      correlationId: "corr_elided_utf8",
    } satisfies WritebackTask;
    const { namespace, requests } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: null,
        encoding: "utf-8",
        contentInline: false,
        streamedContent: '{"ok":true}',
      },
    });
    const bridgeBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bridgeBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
        now: () => new Date("2026-04-17T09:00:00.000Z"),
      },
    );

    expect(requests.map((req) => new URL(req.url).pathname)).toContain(
      "/internal/writeback-content",
    );
    expect(bridgeBodies[0]?.content).toBe('{"ok":true}');
  });

  it("hydrates elided base64 writeback content using chunked base64 encoding", async () => {
    const task = {
      opId: "op_elided_base64",
      workspaceId: "ws_elided_base64",
      path: "/notion/pages/blob.json",
      revision: "rev_elided_base64",
      correlationId: "corr_elided_base64",
    } satisfies WritebackTask;
    const bytes = new Uint8Array(40 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
    const { namespace } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: null,
        encoding: "base64",
        contentInline: false,
        streamedContent: bytes,
      },
    });
    const bridgeBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bridgeBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
        now: () => new Date("2026-04-17T09:00:00.000Z"),
      },
    );

    let expectedBinary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      expectedBinary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    expect(bridgeBodies[0]?.content).toBe(btoa(expectedBinary));
    expect(bridgeBodies[0]?.encoding).toBe("base64");
  });

  it("caps oversized diagnostic bridge response bodies", async () => {
    const task = {
      opId: "op_diagnostic_cap",
      workspaceId: "ws_diagnostic_cap",
      path: "/notion/pages/diagnostic.json",
      revision: "rev_diagnostic_cap",
      correlationId: "corr_diagnostic_cap",
    } satisfies WritebackTask;
    const { namespace } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ ok: true }),
      },
    });
    const fetchImpl = vi.fn(async () => {
      return new Response(
        `diagnostic-start ${"x".repeat(20 * 1024)} diagnostic-tail`,
        { status: 500 },
      );
    });

    const { executeProviderWriteback } = await loadExecutor();
    let message = "";
    try {
      await executeProviderWriteback(
        task,
        {
          WORKSPACE_DO: namespace,
          INTERNAL_HMAC_SECRET: "test-internal-secret",
        },
        {
          bridgeUrl:
            "https://cloud.test/cloud/api/internal/relayfile/writeback",
          fetchImpl: fetchImpl as typeof fetch,
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("diagnostic-start");
    expect(message).not.toContain("diagnostic-tail");
  });

  it("acks oversized hydrated writeback content as a permanent failure", async () => {
    const task = {
      opId: "op_hydrate_too_large",
      workspaceId: "ws_hydrate_too_large",
      path: "/notion/pages/too-large.json",
      revision: "rev_hydrate_too_large",
      correlationId: "corr_hydrate_too_large",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: null,
        contentInline: false,
        streamedContent: "{}",
        streamedContentLength: String(25 * 1024 * 1024 + 1),
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringContaining("exceeds 26214400 bytes"),
      },
    ]);
  });

  it("splits bridge batches before aggregate hydrated content exceeds the cap", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tasks = [
      {
        opId: "op_large_1",
        workspaceId: "ws_large_1",
        path: "/notion/pages/large-1.json",
        revision: "rev_large_1",
        correlationId: "corr_large_1",
      },
      {
        opId: "op_large_2",
        workspaceId: "ws_large_2",
        path: "/notion/pages/large-2.json",
        revision: "rev_large_2",
        correlationId: "corr_large_2",
      },
    ] satisfies WritebackTask[];
    const largeContent = "x".repeat(3 * 1024 * 1024);
    const contexts = new Map(
      tasks.map((task) => [
        task.workspaceId,
        {
          workspaceId: task.workspaceId,
          operation: {
            opId: task.opId,
            path: task.path,
            revision: task.revision,
            action: "file_upsert",
            provider: "notion",
            status: "dispatched",
            correlationId: task.correlationId,
          },
          file: {
            path: task.path,
            revision: task.revision,
            contentType: "application/json",
            content: null,
            encoding: "utf-8",
          },
          contentInline: false,
        },
      ]),
    );
    const namespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get(id: DurableObjectId) {
        const workspaceId = id as unknown as string;
        return {
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            const context = contexts.get(workspaceId);
            if (!context) throw new Error(`missing context for ${workspaceId}`);
            if (url.pathname === "/internal/writeback-context") {
              return new Response(JSON.stringify(context), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            if (url.pathname === "/internal/writeback-content") {
              return new Response(largeContent, {
                status: 200,
                headers: {
                  "X-Relayfile-Encoding": "utf-8",
                  "X-Relayfile-Revision": context.operation.revision,
                },
              });
            }
            if (
              url.pathname.startsWith(
                `/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/`,
              )
            ) {
              return new Response(
                JSON.stringify({
                  code: "not_found",
                  message: "integration not found",
                }),
                {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }
            throw new Error(`Unexpected WorkspaceDO request ${url.pathname}`);
          },
        } as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace;
    const bridgeBodies: Array<{ items?: Array<{ opId?: string }> }> = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          items?: Array<{ opId?: string }>;
        };
        bridgeBodies.push(body);
        return new Response(
          JSON.stringify({
            results: body.items?.map((item) => ({
              opId: item.opId,
              outcome: "success",
            })),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    try {
      const { executeProviderWritebackBatch } = await loadExecutor();
      const results = await executeProviderWritebackBatch(
        tasks,
        {
          WORKSPACE_DO: namespace,
          INTERNAL_HMAC_SECRET: "test-internal-secret",
        },
        {
          bridgeUrl:
            "https://cloud.test/cloud/api/internal/relayfile/writeback",
          fetchImpl: fetchImpl as typeof fetch,
        },
      );

      expect(results.every((result) => result.success)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(bridgeBodies.map((body) => body.items?.length)).toEqual([1, 1]);
      const events = logSpy.mock.calls.map((call) =>
        JSON.parse(String(call[0])),
      ) as Array<{ event?: string; opIds?: string[] }>;
      expect(
        events.some((event) => event.event === "writeback.adapter.resolved"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.event === "writeback.provider.request" &&
            event.opIds?.includes("op_large_1"),
        ),
      ).toBe(true);
      expect(events.some((event) => event.event === "writeback.complete")).toBe(
        true,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns a typed task failure instead of dispatching a single over-cap bridge payload", async () => {
    const task = {
      opId: "op_too_large_for_bridge",
      workspaceId: "ws_too_large_for_bridge",
      path: "/notion/pages/too-large.json",
      revision: "rev_too_large_for_bridge",
      correlationId: "corr_too_large_for_bridge",
    } satisfies WritebackTask;
    const { namespace } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "x".repeat(5 * 1024 * 1024),
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWritebackBatch } = await loadExecutor();
    const results = await executeProviderWritebackBatch(
      [task],
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(results).toEqual([
      {
        task,
        success: false,
        error: expect.stringContaining("exceeds 4194304 bytes"),
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches directly through Nango and ACKs WorkspaceDO when writeback_dispatch_via is cf", async () => {
    const task = {
      opId: "op_notion_cf",
      workspaceId: "ws_notion_cf",
      path: "/notion/databases/db-1/pages/11111111-1111-4111-8111-111111111112.json",
      revision: "rev_notion_cf",
      correlationId: "corr_notion_cf",
    } satisfies WritebackTask;
    const pageJson = JSON.stringify({
      properties: {
        Name: {
          id: "title",
          type: "title",
          value: "Updated directly from Cloudflare",
        },
      },
    });
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: pageJson,
      },
      integration: {
        provider: "notion",
        providerConfigKey: "notion-sage",
        connectionId: "conn_notion_cf",
        aliasFields: { notionApiVersion: "2022-06-28" },
        writebackDispatchVia: "cf",
      },
    });
    const nangoCalls: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        nangoCalls.push({
          url: String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >,
        });
        return new Response(JSON.stringify({ id: "page-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/writeback-context",
      `/v1/workspaces/${task.workspaceId}/integrations/notion`,
      `/v1/workspaces/${task.workspaceId}/writeback/${task.opId}/ack`,
    ]);
    expect(nangoCalls).toHaveLength(1);
    expect(nangoCalls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/v1/pages/11111111-1111-4111-8111-111111111112",
      method: "PATCH",
    });
    expect(nangoCalls[0]?.body).toMatchObject({
      properties: {
        Name: {
          title: [
            {
              plain_text: "Updated directly from Cloudflare",
            },
          ],
        },
      },
    });
    expect(nangoCalls[0]?.headers.get("authorization")).toBe(
      "Bearer nango-secret",
    );
    expect(nangoCalls[0]?.headers.get("connection-id")).toBe("conn_notion_cf");
    expect(nangoCalls[0]?.headers.get("provider-config-key")).toBe(
      "notion-sage",
    );
    expect(nangoCalls[0]?.headers.get("notion-version")).toBe("2022-06-28");
    expect(ackBodies).toHaveLength(1);
    expect(ackBodies[0]).toMatchObject({
      success: true,
      providerResult: {
        providerObjectId: "page-1",
        provider: "notion",
        action: "update_page_properties",
        method: "PATCH",
        endpoint: "/v1/pages/11111111-1111-4111-8111-111111111112",
        status: 200,
        externalId: "page-1",
      },
    });
  });

  it("keeps dispatch_moved batch bridge results retryable so stale DO dispatch flags do not strand operations", async () => {
    const task = {
      opId: "op_dispatch_moved_batch",
      workspaceId: "ws_dispatch_moved_batch",
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_dispatch_moved_batch",
      correlationId: "corr_dispatch_moved_batch",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ properties: {} }),
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                opId: task.opId,
                outcome: "retryable_failure",
                error: {
                  code: "dispatch_moved",
                  message: "Relayfile writeback dispatch moved to Cloudflare",
                },
                relayfileAcked: false,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { executeProviderWritebackBatch } = await loadExecutor();
    const results = await executeProviderWritebackBatch(
      [task],
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(results).toEqual([
      {
        task,
        success: false,
        error: "Relayfile writeback dispatch moved to Cloudflare",
      },
    ]);
    expect(ackBodies).toHaveLength(0);
  });

  it("treats missing batch bridge results as retryable failures", async () => {
    const task = {
      opId: "op_missing_batch_result",
      workspaceId: "ws_missing_batch_result",
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_missing_batch_result",
      correlationId: "corr_missing_batch_result",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ properties: {} }),
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { executeProviderWritebackBatch } = await loadExecutor();
    const results = await executeProviderWritebackBatch(
      [task],
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(results).toEqual([
      {
        task,
        success: false,
        error: `missing batch result for opId ${task.opId}`,
      },
    ]);
    expect(ackBodies).toHaveLength(0);
  });

  it("treats malformed batch bridge outcomes as retryable failures", async () => {
    const task = {
      opId: "op_malformed_batch_result",
      workspaceId: "ws_malformed_batch_result",
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_malformed_batch_result",
      correlationId: "corr_malformed_batch_result",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ properties: {} }),
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [{ opId: task.opId, outcome: "wat" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const { executeProviderWritebackBatch } = await loadExecutor();
    const results = await executeProviderWritebackBatch(
      [task],
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(results).toEqual([
      {
        task,
        success: false,
        error: `unexpected batch outcome for opId ${task.opId}`,
      },
    ]);
    expect(ackBodies).toHaveLength(0);
  });

  it("acks batch stale revision mismatches as permanent failures without retrying", async () => {
    const task = {
      opId: "op_batch_stale",
      workspaceId: "ws_batch_stale",
      path: "/notion/pages/page-batch-stale.json",
      revision: "rev_expected",
      correlationId: "corr_batch_stale",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: "rev_current",
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWritebackBatch } = await loadExecutor();
    const results = await executeProviderWritebackBatch(
      [task],
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toEqual([{ task, success: true }]);
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/revision/i),
      },
    ]);
  });

  it("skips provider execution when the operation is already terminal", async () => {
    const task = {
      opId: "op_terminal",
      workspaceId: "ws_terminal",
      path: "/notion/pages/page-terminal.json",
      revision: "rev_terminal",
      correlationId: "corr_terminal",
    } satisfies WritebackTask;
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "succeeded",
        correlationId: task.correlationId,
      },
      file: null,
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(requests).toHaveLength(1);
    expect(ackBodies).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the bridge request for a Slack canonical message PATCH path", async () => {
    const task = {
      opId: "op_slack_patch",
      workspaceId: "ws_slack_patch",
      path: "/slack/channels/C123/messages/1713220000.000100.json",
      revision: "rev_slack_patch",
      correlationId: "corr_slack_patch",
    } satisfies WritebackTask;
    const messageJson = JSON.stringify({ text: "patched from queue consumer" });
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "slack",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: messageJson,
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(ackBodies).toHaveLength(0);
  });

  it("posts the bridge request for a Linear issueCreate path", async () => {
    const task = {
      opId: "op_linear_create",
      workspaceId: "ws_linear_create",
      path: "/linear/issues/create request.json",
      revision: "rev_linear_create",
      correlationId: "corr_linear_create",
    } satisfies WritebackTask;
    const issueJson = JSON.stringify({
      teamId: "50cf92f3-f53c-4ab6-bf05-ea76ebd21692",
      title: "Created from queue consumer",
    });
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "linear",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: issueJson,
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ackBodies).toHaveLength(0);
  });

  it.each([
    {
      name: "label create",
      opId: "op_linear_label_create",
      workspaceId: "ws_linear_label_create",
      path: "/linear/labels/create-area-harnesses.json",
      revision: "rev_linear_label_create",
      correlationId: "corr_linear_label_create",
      content: { name: "area-harnesses", color: "#5e6ad2" },
    },
    {
      name: "project create",
      opId: "op_linear_project_create",
      workspaceId: "ws_linear_project_create",
      path: "/linear/projects/create-roadmap.json",
      revision: "rev_linear_project_create",
      correlationId: "corr_linear_project_create",
      content: { name: "Roadmap", teamId: "team-1" },
    },
    {
      name: "project update",
      opId: "op_linear_project_update",
      workspaceId: "ws_linear_project_update",
      path: "/linear/projects/11111111-1111-4111-8111-111111111111/meta.json",
      revision: "rev_linear_project_update",
      correlationId: "corr_linear_project_update",
      content: { name: "Updated roadmap" },
    },
    {
      name: "project issue assignment",
      opId: "op_linear_project_assign",
      workspaceId: "ws_linear_project_assign",
      path: "/linear/projects/11111111-1111-4111-8111-111111111111/add-issues.json",
      revision: "rev_linear_project_assign",
      correlationId: "corr_linear_project_assign",
      content: { issueIds: ["22222222-2222-4222-8222-222222222222"] },
    },
  ])("posts the bridge request for a Linear $name path", async (entry) => {
    const task = {
      opId: entry.opId,
      workspaceId: entry.workspaceId,
      path: entry.path,
      revision: entry.revision,
      correlationId: entry.correlationId,
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "linear",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify(entry.content),
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ackBodies).toHaveLength(0);
  });

  it("acks Linear writeback paths outside the supported set as permanent failures", async () => {
    const task = {
      opId: "op_linear_unsupported",
      workspaceId: "ws_linear_unsupported",
      // Linear sync surfaces /linear/users/<id>.json — read-only, no writeback.
      path: "/linear/users/0741e09a-dd2b-4197-8656-cf5f56240b96.json",
      revision: "rev_linear_unsupported",
      correlationId: "corr_linear_unsupported",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "linear",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Linear writeback path/i),
      },
    ]);
  });

  it("acks Linear nested writes when the parent issue name is a create draft", async () => {
    const task = {
      opId: "op_linear_draft_parent",
      workspaceId: "ws_linear_draft_parent",
      path: "/linear/issues/create request/comments/comment draft.json",
      revision: "rev_linear_draft_parent",
      correlationId: "corr_linear_draft_parent",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "linear",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Linear writeback path/i),
      },
    ]);
  });

  it("posts the bridge request for a Slack chat.postMessage path", async () => {
    const task = {
      opId: "op_slack_post",
      workspaceId: "ws_slack_post",
      path: "/slack/channels/customer-success/messages/create request.json",
      revision: "rev_slack_post",
      correlationId: "corr_slack_post",
    } satisfies WritebackTask;
    const messageJson = JSON.stringify({ text: "hello from queue consumer" });
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "slack",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: messageJson,
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ackBodies).toHaveLength(0);
  });

  for (const sample of [
    {
      provider: "github",
      path: "/github/repos/AgentWorkforce/cloud/issues/create request.json",
      content: JSON.stringify({ title: "Track deploy", body: "Details" }),
    },
    {
      provider: "github",
      path: "/github/repos/AgentWorkforce/cloud/issues/42/comments/create comment.json",
      content: JSON.stringify({ body: "Following up" }),
    },
    {
      provider: "slack",
      path: "/slack/users/U12345678/messages/create.json",
      content: JSON.stringify({ text: "DM from runtime" }),
    },
    {
      provider: "jira",
      path: "/jira/issues/ENG-42/transitions/start-progress.json",
      content: JSON.stringify({ transition: { id: "31" } }),
    },
    {
      provider: "confluence",
      path: "/confluence/spaces/688132/pages/create-page.json",
      content: JSON.stringify({
        title: "Relayfile writeback test",
        body: "<p>Created from Relayfile.</p>",
      }),
    },
  ] as const) {
    it(`posts the bridge request for ${sample.provider} ${sample.path}`, async () => {
      const task = {
        opId: `op_${sample.provider}_new_writeback`,
        workspaceId: `ws_${sample.provider}_new_writeback`,
        path: sample.path,
        revision: "rev_new_writeback",
        correlationId: "corr_new_writeback",
      } satisfies WritebackTask;
      const { namespace, ackBodies } = createWorkspaceNamespace({
        workspaceId: task.workspaceId,
        operation: {
          opId: task.opId,
          path: task.path,
          revision: task.revision,
          action: "file_upsert",
          provider: sample.provider,
          status: "dispatched",
          correlationId: task.correlationId,
        },
        file: {
          path: task.path,
          revision: task.revision,
          content: sample.content,
        },
      });
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

      const { executeProviderWriteback } = await loadExecutor();
      await executeProviderWriteback(
        task,
        {
          WORKSPACE_DO: namespace,
          INTERNAL_HMAC_SECRET: "test-internal-secret",
        },
        {
          bridgeUrl:
            "https://cloud.test/cloud/api/internal/relayfile/writeback",
          fetchImpl: fetchImpl as typeof fetch,
        },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ackBodies).toHaveLength(0);
    });
  }

  it("acks GitHub synced issue indexes as unsupported writeback paths", async () => {
    const task = {
      opId: "op_github_index",
      workspaceId: "ws_github_index",
      path: "/github/repos/AgentWorkforce/cloud/issues/_index.json",
      revision: "rev_github_index",
      correlationId: "corr_github_index",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "github",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ title: "Should not create" }),
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported GitHub writeback path/i),
      },
    ]);
  });

  it("acks Confluence synced indexes as unsupported writeback paths", async () => {
    const task = {
      opId: "op_confluence_index",
      workspaceId: "ws_confluence_index",
      path: "/confluence/spaces/688132/pages/_index.json",
      revision: "rev_confluence_index",
      correlationId: "corr_confluence_index",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "confluence",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({ title: "Should not create" }),
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Confluence writeback path/i),
      },
    ]);
  });

  it("acks Slack writeback paths outside the supported set as permanent failures", async () => {
    const task = {
      opId: "op_slack_unsupported",
      workspaceId: "ws_slack_unsupported",
      // Slack sync surfaces /slack/users/<id>.json and /slack/channels/<channel>/info.json
      // — read-only, no writeback target.
      path: "/slack/users/U123.json",
      revision: "rev_slack_unsupported",
      correlationId: "corr_slack_unsupported",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "slack",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Slack writeback path/i),
      },
    ]);
  });

  it("acks Slack nested writes when the parent message name is a create draft", async () => {
    const task = {
      opId: "op_slack_draft_parent",
      workspaceId: "ws_slack_draft_parent",
      path: "/slack/channels/C123/messages/create request/replies/reply draft.json",
      revision: "rev_slack_draft_parent",
      correlationId: "corr_slack_draft_parent",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "slack",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Slack writeback path/i),
      },
    ]);
  });

  it("acks Slack reaction upserts that look like canonical reaction updates", async () => {
    const task = {
      opId: "op_slack_reaction_patch",
      workspaceId: "ws_slack_reaction_patch",
      path: "/slack/channels/C123/messages/1713220000.000100/reactions/thumbsup.json",
      revision: "rev_slack_reaction_patch",
      correlationId: "corr_slack_reaction_patch",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "slack",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/unsupported Slack writeback path/i),
      },
    ]);
  });

  it("posts the bridge request for a Linear file_delete path without loading file content", async () => {
    const task = {
      opId: "op_linear_delete",
      workspaceId: "ws_linear_delete",
      path: "/linear/issues/11111111-1111-4111-8111-111111111111.json",
      revision: "rev_linear_delete",
      correlationId: "corr_linear_delete",
    } satisfies WritebackTask;
    const bridgeCalls: Array<Record<string, unknown>> = [];
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_delete",
        provider: "linear",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: null,
    });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bridgeCalls.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(ackBodies).toHaveLength(0);
    expect(bridgeCalls[0]).toMatchObject({
      action: "file_delete",
      content: "",
      path: task.path,
    });
  });

  it("posts the bridge request for a Confluence file_delete path without loading file content", async () => {
    const task = {
      opId: "op_confluence_delete",
      workspaceId: "ws_confluence_delete",
      path: "/confluence/spaces/688132/pages/relayfile-writeback-test__123456.json",
      revision: "rev_confluence_delete",
      correlationId: "corr_confluence_delete",
    } satisfies WritebackTask;
    const bridgeCalls: Array<Record<string, unknown>> = [];
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_delete",
        provider: "confluence",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: null,
    });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bridgeCalls.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(ackBodies).toHaveLength(0);
    expect(bridgeCalls[0]).toMatchObject({
      action: "file_delete",
      content: "",
      path: task.path,
    });
  });

  it("acks stale revision mismatches as permanent failures without sending provider content", async () => {
    const task = {
      opId: "op_stale",
      workspaceId: "ws_stale",
      path: "/notion/pages/page-stale.json",
      revision: "rev_expected",
      correlationId: "corr_stale",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: "rev_current",
        content: "{}",
      },
    });
    const fetchImpl = vi.fn();

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
      },
      {
        bridgeUrl: "https://cloud.test/cloud/api/internal/relayfile/writeback",
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ackBodies).toEqual([
      {
        success: false,
        error: expect.stringMatching(/revision/i),
      },
    ]);
  });

  it("redacts secret-bearing bridge failures instead of surfacing raw Authorization text", async () => {
    const task = {
      opId: "op_redacted",
      workspaceId: "ws_redacted",
      path: "/notion/pages/page-secret.json",
      revision: "rev_redacted",
      correlationId: "corr_redacted",
    } satisfies WritebackTask;
    const { namespace, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "notion",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: JSON.stringify({
          properties: {
            Name: {
              id: "title",
              type: "title",
              value: "Secret-safe failure",
            },
          },
        }),
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          "bridge failure Authorization: Bearer nango-secret should never leak",
          { status: 502 },
        ),
    );

    const { executeProviderWriteback } = await loadExecutor();

    await expect(
      executeProviderWriteback(
        task,
        {
          WORKSPACE_DO: namespace,
          INTERNAL_HMAC_SECRET: "test-internal-secret",
        },
        {
          bridgeUrl:
            "https://cloud.test/cloud/api/internal/relayfile/writeback",
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.toThrow(/bridge/i);

    await expect(
      executeProviderWriteback(
        task,
        {
          WORKSPACE_DO: namespace,
          INTERNAL_HMAC_SECRET: "test-internal-secret",
        },
        {
          bridgeUrl:
            "https://cloud.test/cloud/api/internal/relayfile/writeback",
          fetchImpl: fetchImpl as typeof fetch,
        },
      ),
    ).rejects.not.toThrow(/Authorization|nango-secret/);
    expect(ackBodies).toHaveLength(0);
  });

  it("routes Google Mail label draft creates to Cloudflare-native dispatch", async () => {
    const task = {
      opId: "op_google_mail_label_create",
      workspaceId: "ws_google_mail",
      path: "/google-mail/labels/draft-20260521T094857Z.json",
      revision: "rev_google_mail_label_create",
      correlationId: "corr_google_mail_label_create",
    } satisfies WritebackTask;
    const labelJson = JSON.stringify({
      name: "relayfile-writeback-test-20260521T094857Z",
      type: "user",
      messageListVisibility: "show",
      labelListVisibility: "labelShow",
      textColor: "#ffffff",
      backgroundColor: "#fb4c2f",
    });
    const { namespace, requests, ackBodies } = createWorkspaceNamespace({
      workspaceId: task.workspaceId,
      operation: {
        opId: task.opId,
        path: task.path,
        revision: task.revision,
        action: "file_upsert",
        provider: "google-mail",
        status: "dispatched",
        correlationId: task.correlationId,
      },
      file: {
        path: task.path,
        revision: task.revision,
        content: labelJson,
      },
      integration: {
        provider: "google-mail",
        providerConfigKey: "google-mail-relay",
        connectionId: "conn_google_mail",
        writebackDispatchVia: "cf",
      },
    });
    const nangoCalls: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        nangoCalls.push({
          url: String(input),
          method: init?.method,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<
            string,
            unknown
          >,
        });
        return new Response(JSON.stringify({ id: "Label_123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    const { executeProviderWriteback } = await loadExecutor();
    await executeProviderWriteback(
      task,
      {
        WORKSPACE_DO: namespace,
        INTERNAL_HMAC_SECRET: "test-internal-secret",
        NANGO_SECRET_KEY: "nango-secret",
        NANGO_BASE_URL: "https://api.nango.test",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
      },
    );

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/writeback-context",
      `/v1/workspaces/${task.workspaceId}/integrations/google-mail`,
      `/v1/workspaces/${task.workspaceId}/writeback/${task.opId}/ack`,
    ]);
    expect(nangoCalls).toHaveLength(1);
    expect(nangoCalls[0]).toMatchObject({
      url: "https://api.nango.test/proxy/gmail/v1/users/me/labels",
      method: "POST",
      body: {
        name: "relayfile-writeback-test-20260521T094857Z",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        color: {
          textColor: "#ffffff",
          backgroundColor: "#fb4c2f",
        },
      },
    });
    expect(nangoCalls[0]?.headers.get("connection-id")).toBe(
      "conn_google_mail",
    );
    expect(nangoCalls[0]?.headers.get("provider-config-key")).toBe(
      "google-mail-relay",
    );
    expect(ackBodies).toHaveLength(1);
    expect(ackBodies[0]).toMatchObject({
      success: true,
      providerResult: {
        providerObjectId: "Label_123",
        provider: "google-mail",
        action: "create_label",
        method: "POST",
        endpoint: "/gmail/v1/users/me/labels",
        status: 200,
        externalId: "Label_123",
      },
    });
  });
});
