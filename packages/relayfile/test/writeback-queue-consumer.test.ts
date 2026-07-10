import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeProviderWritebackBatchMock } = vi.hoisted(() => ({
  executeProviderWritebackBatchMock: vi.fn(),
}));

vi.mock("../src/writeback/provider-executor.js", () => ({
  executeProviderWritebackBatch: executeProviderWritebackBatchMock,
}));

type WritebackMessage = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
};

type QueueMessageStub = {
  body: unknown;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

type QueueBatchStub = {
  queue: string;
  messages: QueueMessageStub[];
  ackAll: ReturnType<typeof vi.fn>;
  retryAll: ReturnType<typeof vi.fn>;
};

function createEnv() {
  const d1Prepare = vi.fn((query: string) => ({
    bind: vi.fn((...bindings: unknown[]) => ({
      run: vi.fn(async () => ({ success: true, query, bindings })),
    })),
  }));
  const workspaceFetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.includes("/writeback/") && url.pathname.endsWith("/ack")) {
      return new Response(
        JSON.stringify({
          status: "acknowledged",
          success: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/internal/webhook-delivery-result") {
      return new Response(JSON.stringify({ status: "acknowledged" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected WorkspaceDO request ${url.pathname}`);
  });

  return {
    DB: { prepare: d1Prepare } as unknown as D1Database,
    CONTENT_BUCKET: {} as R2Bucket,
    ENVELOPE_QUEUE: {} as Queue,
    WRITEBACK_QUEUE: {} as Queue,
    WORKSPACE_DO: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          fetch: workspaceFetch,
        } as unknown as DurableObjectStub;
      },
    } as unknown as DurableObjectNamespace,
    KV: {} as KVNamespace,
    ENVIRONMENT: "test",
    RELAYFILE_WRITEBACK_BRIDGE_URL:
      "https://cloud.test/cloud/api/internal/relayfile/writeback",
    INTERNAL_HMAC_SECRET: "test-internal-secret",
    RELAYFILE_JWT_SECRET: "test-relay-secret",
    __workspaceFetch: workspaceFetch,
    __d1Prepare: d1Prepare,
  };
}

function createBatch(message: WritebackMessage, attempts = 1): QueueBatchStub {
  return {
    queue: "relayfile-writeback",
    messages: [
      {
        body: message,
        attempts,
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}

async function loadConsumer() {
  return import("../src/queue-consumer.js");
}

describe("relayfile writeback queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("delegates relayfile-writeback messages to the provider executor before acking", async () => {
    const events: string[] = [];
    const message = {
      opId: "op_writeback_1",
      workspaceId: "ws_writeback_1",
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_1",
      correlationId: "corr_writeback_1",
    } satisfies WritebackMessage;
    const batch = createBatch(message);
    const env = createEnv();

    executeProviderWritebackBatchMock.mockImplementation(async (tasks) => {
      events.push("executor:start");
      await Promise.resolve();
      events.push("executor:done");
      return tasks.map((task: WritebackMessage) => ({ task, success: true }));
    });
    batch.messages[0].ack.mockImplementation(() => {
      events.push("message:ack");
    });

    const consumer = await loadConsumer();
    await consumer.default.queue(batch as unknown as MessageBatch, env);

    expect(executeProviderWritebackBatchMock).toHaveBeenCalledTimes(1);
    expect(executeProviderWritebackBatchMock).toHaveBeenCalledWith(
      [message],
      env,
    );
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    expect(events).toEqual(["executor:start", "executor:done", "message:ack"]);
  });

  it("routes queue names through the additive branch resolver", async () => {
    const { branchByQueueName } = await loadConsumer();

    expect(branchByQueueName("relayfile-writeback")).toBe("writeback");
    expect(branchByQueueName("relayfile-envelopes-preview")).toBe("envelope");
    expect(branchByQueueName("relayfile-webhooks")).toBe("webhook-delivery");
    expect(branchByQueueName("relayfile-webhooks-pr-123")).toBe(
      "webhook-delivery",
    );
    expect(branchByQueueName("relayfile-unknown")).toBeNull();
  });

  it("posts signed outbound webhook deliveries and reports success", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = createEnv();
    const message = {
      type: "webhook_delivery",
      deliveryId: "whdel_1",
      workspaceId: "ws_webhook",
      subscriptionId: "whsub_1",
      url: "https://subscriber.test/hook",
      secret: "webhook-secret",
      event: {
        eventId: "evt_webhook_1",
        type: "file.updated",
        path: "/linear/issues/ISS-1.json",
        revision: "rev_1",
        origin: "provider_sync",
        provider: "linear",
        correlationId: "corr_webhook_1",
        timestamp: "2026-06-15T00:00:00.000Z",
        contentHash: "abc123",
      },
      enqueuedAt: "2026-06-15T00:00:01.000Z",
    };
    const msg = {
      body: message,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: "relayfile-webhooks",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    try {
      const consumer = await loadConsumer();
      await consumer.default.queue(batch as unknown as MessageBatch, env);
    } finally {
      global.fetch = originalFetch;
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstFetchCall = fetchMock.mock.calls[0] as
      | [Parameters<typeof fetch>[0], RequestInit]
      | undefined;
    expect(firstFetchCall).toBeDefined();
    const [, init] = firstFetchCall!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Relay-Event-Id"]).toBe(
      "evt_webhook_1",
    );
    expect(
      (init.headers as Record<string, string>)["X-Relay-Timestamp"],
    ).toMatch(/^\d+$/);
    expect(
      (init.headers as Record<string, string>)["X-Relay-Signature"],
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body))).toMatchObject({
      eventId: "evt_webhook_1",
      provider: "linear",
      correlationId: "corr_webhook_1",
      contentHash: "abc123",
    });
    expect(env.__workspaceFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://workspace-do/internal/webhook-delivery-result",
      }),
    );
    const workspaceRequest = env.__workspaceFetch.mock.calls[0]?.[0] as
      | Request
      | undefined;
    expect(workspaceRequest).toBeDefined();
    const deliveryResultBody = (await workspaceRequest!.json()) as Record<
      string,
      unknown
    >;
    expect(deliveryResultBody).toMatchObject({
      workspaceId: "ws_webhook",
      subscriptionId: "whsub_1",
      url: "https://subscriber.test/hook",
      success: true,
    });
    expect(deliveryResultBody.event).toMatchObject({
      eventId: "evt_webhook_1",
    });
    expect(deliveryResultBody).not.toHaveProperty("secret");
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries outbound webhook deliveries instead of following redirects", async () => {
    const originalFetch = global.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    const env = createEnv();
    const message = {
      type: "webhook_delivery",
      deliveryId: "whdel_redirect",
      workspaceId: "ws_webhook",
      subscriptionId: "whsub_redirect",
      url: "https://subscriber.test/hook",
      secret: "webhook-secret",
      event: {
        eventId: "evt_redirect",
        type: "file.updated",
        path: "/linear/issues/ISS-1.json",
        revision: "rev_1",
        origin: "provider_sync",
        provider: "linear",
        timestamp: "2026-06-15T00:00:00.000Z",
      },
      enqueuedAt: "2026-06-15T00:00:01.000Z",
    };
    const msg = {
      body: message,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: "relayfile-webhooks",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    try {
      const consumer = await loadConsumer();
      await consumer.default.queue(batch as unknown as MessageBatch, env);
    } finally {
      global.fetch = originalFetch;
      vi.unstubAllGlobals();
    }

    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(env.__workspaceFetch).not.toHaveBeenCalled();
  });

  it("dead-letters outbound webhook delivery after the final retry", async () => {
    const originalFetch = global.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const env = createEnv();
    const message = {
      type: "webhook_delivery",
      deliveryId: "whdel_final",
      workspaceId: "ws_webhook",
      subscriptionId: "whsub_final",
      url: "https://subscriber.test/hook",
      secret: "webhook-secret",
      event: {
        eventId: "evt_final",
        type: "file.updated",
        path: "/linear/issues/ISS-2.json",
        revision: "rev_2",
        origin: "provider_sync",
        provider: "linear",
        correlationId: "corr_final",
        timestamp: "2026-06-15T00:00:00.000Z",
      },
      enqueuedAt: "2026-06-15T00:00:01.000Z",
    };
    const msg = {
      body: message,
      attempts: 3,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: "relayfile-webhooks",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    try {
      const consumer = await loadConsumer();
      await consumer.default.queue(batch as unknown as MessageBatch, env);
    } finally {
      global.fetch = originalFetch;
      vi.unstubAllGlobals();
    }

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(env.__d1Prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO webhook_delivery_dead_letters"),
    );
  });

  it("retries envelope messages when WorkspaceDO overload is translated to 429", async () => {
    const env = createEnv();
    env.__workspaceFetch.mockRejectedValueOnce(
      new Error("Durable Object is overloaded. Requests queued for too long."),
    );
    (
      env as typeof env & { RELAYFILE_DO_RETRY_AFTER_SECONDS: string }
    ).RELAYFILE_DO_RETRY_AFTER_SECONDS = "9";
    const msg = {
      body: {
        envelopeId: "env_overloaded",
        workspaceId: "ws_overloaded",
        provider: "github",
        correlationId: "corr_overloaded",
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: "relayfile-envelopes",
      messages: [msg],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };

    const consumer = await loadConsumer();
    await consumer.default.queue(batch as unknown as MessageBatch, env);

    expect(env.__workspaceFetch).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledTimes(1);
  });

  it("retries writeback messages when provider execution fails instead of acking", async () => {
    const message = {
      opId: "op_writeback_2",
      workspaceId: "ws_writeback_2",
      path: "/notion/databases/db-2/pages/page-2/content.md",
      revision: "rev_2",
      correlationId: "corr_writeback_2",
    } satisfies WritebackMessage;
    const batch = createBatch(message);
    const env = createEnv();

    executeProviderWritebackBatchMock.mockResolvedValue([
      { task: message, success: false, error: "bridge returned 502" },
    ]);

    const consumer = await loadConsumer();
    await consumer.default.queue(batch as unknown as MessageBatch, env);

    expect(executeProviderWritebackBatchMock).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
    expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(env.__workspaceFetch).not.toHaveBeenCalled();
  });

  it("keeps duplicate opId messages correlated to their own batch result", async () => {
    const first = {
      opId: "op_duplicate",
      workspaceId: "ws_duplicate",
      path: "/notion/pages/page-duplicate.json",
      revision: "rev_first",
      correlationId: "corr_first",
    } satisfies WritebackMessage;
    const second = {
      ...first,
      revision: "rev_second",
      correlationId: "corr_second",
    } satisfies WritebackMessage;
    const batch = {
      queue: "relayfile-writeback",
      messages: [
        {
          body: first,
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
        {
          body: second,
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies QueueBatchStub;
    const env = createEnv();

    executeProviderWritebackBatchMock.mockResolvedValue([
      { task: first, success: true },
      { task: second, success: false, error: "retry me" },
    ]);

    const consumer = await loadConsumer();
    await consumer.default.queue(batch as unknown as MessageBatch, env);

    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    expect(batch.messages[1].ack).not.toHaveBeenCalled();
    expect(batch.messages[1].retry).toHaveBeenCalledTimes(1);
  });

  it("marks the writeback failed on the final queue attempt instead of deleting a stranded dispatched op", async () => {
    const message = {
      opId: "op_writeback_3",
      workspaceId: "ws_writeback_3",
      path: "/notion/pages/page-3.json",
      revision: "rev_3",
      correlationId: "corr_writeback_3",
    } satisfies WritebackMessage;
    const batch = createBatch(message, 3);
    const env = createEnv();

    executeProviderWritebackBatchMock.mockResolvedValue([
      {
        task: message,
        success: false,
        error:
          "provider writeback bridge request failed: Authorization: Bearer nango-secret",
      },
    ]);

    const consumer = await loadConsumer();
    await consumer.default.queue(batch as unknown as MessageBatch, env);

    expect(executeProviderWritebackBatchMock).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(env.__workspaceFetch).toHaveBeenCalledTimes(1);

    const ackRequest = env.__workspaceFetch.mock.calls[0]?.[0] as Request;
    expect(ackRequest.url).toContain(
      `/v1/workspaces/${message.workspaceId}/writeback/${message.opId}/ack`,
    );
    await expect(ackRequest.clone().json()).resolves.toEqual({
      success: false,
      error: expect.not.stringMatching(/Authorization|nango-secret/),
    });
  });

  it("dispatches a backend-neutral provider field equal to the lowercased first path segment", async () => {
    // Contract: the queue-consumer → executor → bridge path must place the
    // workspace-integration alias (lowercased first path segment) on the
    // bridge request body's `provider` field. This locks in the
    // backend-neutral dispatch shape so a future slice cannot rename it
    // to a backend-specific name (e.g. "nangoConfigKey", "composioToolkit").
    const originalFetch = global.fetch;

    const message = {
      opId: "op_writeback_provider_contract",
      workspaceId: "ws_writeback_provider_contract",
      path: "/notion/databases/db-1/pages/page-1.json",
      revision: "rev_provider_contract",
      correlationId: "corr_provider_contract",
    } satisfies WritebackMessage;
    const batch = createBatch(message);

    const ackBodies: Record<string, unknown>[] = [];
    const workspaceFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/internal/writeback-context") {
        return new Response(
          JSON.stringify({
            workspaceId: message.workspaceId,
            operation: {
              opId: message.opId,
              path: message.path,
              revision: message.revision,
              action: "file_upsert",
              provider: "notion",
              status: "dispatched",
              correlationId: message.correlationId,
            },
            file: {
              path: message.path,
              revision: message.revision,
              contentType: "application/json",
              content: JSON.stringify({ properties: {} }),
              encoding: "utf-8",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.includes("/integrations/")) {
        return new Response(
          JSON.stringify({
            code: "not_found",
            message: "integration not found",
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        url.pathname.includes("/writeback/") &&
        url.pathname.endsWith("/ack")
      ) {
        ackBodies.push(
          (await request
            .clone()
            .json()
            .catch(() => ({}))) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({ status: "acknowledged", success: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected WorkspaceDO request ${url.pathname}`);
    });

    const bridgeBodies: { items?: Record<string, unknown>[] }[] = [];
    const fetchStub = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        bridgeBodies.push(
          JSON.parse(String(init?.body ?? "{}")) as {
            items?: Record<string, unknown>[];
          },
        );
        void input;
        return new Response(
          JSON.stringify({
            results: [{ opId: message.opId, outcome: "success" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );

    try {
      vi.resetModules();
      vi.doUnmock("../src/writeback/provider-executor.js");
      vi.stubGlobal("fetch", fetchStub);

      const env = {
        DB: {} as D1Database,
        CONTENT_BUCKET: {} as R2Bucket,
        ENVELOPE_QUEUE: {} as Queue,
        WRITEBACK_QUEUE: {} as Queue,
        WORKSPACE_DO: {
          idFromName(name: string) {
            return name as unknown as DurableObjectId;
          },
          get() {
            return { fetch: workspaceFetch } as unknown as DurableObjectStub;
          },
        } as unknown as DurableObjectNamespace,
        KV: {} as KVNamespace,
        ENVIRONMENT: "test",
        RELAYFILE_WRITEBACK_BRIDGE_URL:
          "https://cloud.test/cloud/api/internal/relayfile/writeback",
        INTERNAL_HMAC_SECRET: "test-internal-secret",
        RELAYFILE_JWT_SECRET: "test-relay-secret",
      };
      const consumer = await loadConsumer();
      await consumer.default.queue(batch as unknown as MessageBatch, env);
    } finally {
      global.fetch = originalFetch;
      vi.unstubAllGlobals();
      vi.resetModules();
      vi.doUnmock("../src/writeback/provider-executor.js");
      vi.doMock("../src/writeback/provider-executor.js", () => ({
        executeProviderWritebackBatch: executeProviderWritebackBatchMock,
      }));
    }

    expect(bridgeBodies).toHaveLength(1);
    const expectedProvider = message.path.split("/")[1]?.toLowerCase();
    expect(expectedProvider).toBe("notion");
    expect(bridgeBodies[0]?.items?.[0]?.provider).toBe(expectedProvider);
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].retry).not.toHaveBeenCalled();
  });
});
