import { afterEach, describe, expect, it, vi } from "vitest";
import { env as cloudflareEnv } from "cloudflare:workers";
import worker from "../src/index";
import {
  processWebhookQueueBatch,
  processWebhookQueueMessage,
} from "../src/queue-consumer";
import type { QueueConsumerOptions } from "../src/queue-consumer";
import type {
  DedupeClaimInput,
  DedupeClaimResult,
  DedupeKey,
  NangoSyncDedupStore,
} from "../src/dedup";
import type {
  GitLabHookdeckQueueMessage,
  LegacyWebhookQueueMessage,
  NangoForwardQueueMessage,
  NangoSyncQueueMessage,
  WebhookQueueMessage,
} from "../src/types";
import { createEnv } from "./helpers";

function createMessage<T extends WebhookQueueMessage | LegacyWebhookQueueMessage | null>(
  body: T,
  id = "msg-1",
) {
  return {
    id,
    timestamp: new Date("2026-05-19T00:00:00Z"),
    body,
    attempts: 1,
    retry: vi.fn(),
    ack: vi.fn(),
  };
}

class QueueTestDedupStore implements NangoSyncDedupStore {
  claims: DedupeClaimInput[] = [];
  completed: DedupeKey[] = [];
  failed: DedupeKey[] = [];

  constructor(private readonly result?: DedupeClaimResult) {}

  async claim(input: DedupeClaimInput): Promise<DedupeClaimResult> {
    this.claims.push(input);
    return this.result ?? {
      type: "claimed",
      key: { surface: input.surface, dedupeId: input.dedupeId },
      attemptCount: 1,
      leaseExpiresAt: new Date("2026-05-19T00:01:00Z"),
    };
  }

  async complete(key: DedupeKey): Promise<void> {
    this.completed.push(key);
  }

  async fail(key: DedupeKey): Promise<void> {
    this.failed.push(key);
  }
}

class StatefulQueueTestDedupStore implements NangoSyncDedupStore {
  claims: DedupeClaimInput[] = [];
  completed: DedupeKey[] = [];
  failed: DedupeKey[] = [];
  private readonly statuses = new Map<string, "processing" | "completed">();

  async claim(input: DedupeClaimInput): Promise<DedupeClaimResult> {
    this.claims.push(input);
    const key = { surface: input.surface, dedupeId: input.dedupeId };
    const status = this.statuses.get(input.dedupeId);
    if (status === "completed") {
      return {
        type: "duplicate_completed",
        key,
        completedAt: new Date("2026-05-19T00:00:10Z"),
      };
    }
    if (status === "processing") {
      return {
        type: "duplicate_in_flight",
        key,
        leaseExpiresAt: new Date("2026-05-19T00:01:00Z"),
      };
    }
    this.statuses.set(input.dedupeId, "processing");
    return {
      type: "claimed",
      key,
      attemptCount: 1,
      leaseExpiresAt: new Date("2026-05-19T00:01:00Z"),
    };
  }

  async complete(key: DedupeKey): Promise<void> {
    this.completed.push(key);
    this.statuses.set(key.dedupeId, "completed");
  }

  async fail(key: DedupeKey): Promise<void> {
    this.failed.push(key);
    this.statuses.delete(key.dedupeId);
  }
}

function createNangoSyncQueueMessage(
  overrides: Partial<NangoSyncQueueMessage> = {},
): NangoSyncQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "nango-sync",
    requestId: "req-1",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {},
    payload: {
      storage: "inline",
      body: "{}",
      sizeBytes: 2,
      sha256: "hash",
    },
    nango: {
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      queryTimeStamp: "2026-05-19T00:00:00Z",
      cursor: "cursor-1",
      providerConfigKey: "confluence-relay",
    },
    dedupe: {
      kind: "nango-sync",
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      windowKey: "2026-05-19T00:00:00Z",
      cursorKey: "cursor-1",
    },
    ...overrides,
  };
}

function createNangoForwardQueueMessage(
  overrides: Partial<NangoForwardQueueMessage> = {},
): NangoForwardQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "nango-forward",
    requestId: "req-forward",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {
      "content-type": "application/json",
      "x-nango-hmac-sha256": "signature",
    },
    payload: {
      storage: "inline",
      body: "{\"type\":\"forward\",\"from\":\"github-app-oauth\"}",
      sizeBytes: 43,
      sha256: "hash",
    },
    nango: {
      envelopeType: "forward",
      from: "github-app-oauth",
      connectionId: "conn-forward-1",
      providerConfigKey: "github-relay",
    },
    dedupe: {
      kind: "nango-forward",
      connectionId: "conn-forward-1",
      deliveryId: "delivery-1",
    },
    ...overrides,
  };
}

function createGitLabHookdeckQueueMessage(
  overrides: Partial<GitLabHookdeckQueueMessage> = {},
): GitLabHookdeckQueueMessage {
  return {
    version: 2,
    provider: "nango",
    ingress: "gitlab-hookdeck",
    requestId: "req-gitlab",
    receivedAt: "2026-05-19T00:00:00Z",
    headers: {
      "content-type": "application/json",
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-event-uuid": "evt-1",
    },
    payload: {
      storage: "inline",
      body: "{}",
      sizeBytes: 2,
      sha256: "hash",
    },
    gitlab: {
      event: "Merge Request Hook",
      eventUuid: "evt-1",
      projectId: "123",
    },
    hookdeck: {},
    dedupe: {
      kind: "gitlab-hookdeck-delivery",
      deliveryId: "evt-1",
    },
    ...overrides,
  };
}

describe("queue foundation consumer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits one bounded evidence POST for a DLQ batch", async () => {
    const env = createEnv({
      ENVIRONMENT: "production",
      DEPLOY_VERSION: "abc1234",
      NIGHTCTO_EVIDENCE_URL: "https://nightcto.example/webhooks/cloud-runtime",
      NIGHTCTO_EVIDENCE_TOKEN: "secret-token",
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waits.push(promise);
      },
    } as unknown as ExecutionContext;
    const message1 = createMessage(createNangoSyncQueueMessage({
      requestId: "req-dlq-1",
    }), "msg-dlq-1");
    const message2 = createMessage(createNangoSyncQueueMessage({
      requestId: "req-dlq-2",
    }), "msg-dlq-2");

    await processWebhookQueueBatch(
      {
        messages: [message1, message2],
        queue: "webhook-events-dlq",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      ctx,
    );
    await Promise.all(waits);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://nightcto.example/webhooks/cloud-runtime");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret-token",
      "x-nightcto-evidence-token": "secret-token",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      schemaVersion: "cloud-runtime-evidence/1",
      service: "webhook-worker",
      environment: "production",
      version: "abc1234",
      path: "webhook.queue.dlq",
      kind: "dlq_dead_letter",
      outcome: "dlq",
      severity: 8,
      requestId: "req-dlq-1",
      correlationIds: {
        messageId: "msg-dlq-1",
        provider: "nango",
        ingress: "nango-sync",
      },
      summary: "2 webhook message(s) dead-lettered on webhook-events-dlq (provider=nango)",
      counts: {
        messages: 2,
        errors: 2,
      },
      inspect: {
        dlqQueue: "webhook-events-dlq",
      },
    });
    expect(message1.ack).toHaveBeenCalledOnce();
    expect(message2.ack).toHaveBeenCalledOnce();
  });

  it("retries nango sync messages until provider parity is enabled", async () => {
    const env = createEnv();
    const message = createMessage<WebhookQueueMessage>({
      version: 2,
      provider: "nango",
      ingress: "nango-sync",
      requestId: "req-1",
      receivedAt: "2026-05-19T00:00:00Z",
      headers: {},
      payload: {
        storage: "inline",
        body: "{}",
        sizeBytes: 2,
        sha256: "hash",
      },
      nango: {},
      dedupe: {
        kind: "nango-sync",
      },
    });

    await worker.queue(
      {
        messages: [message],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("preserves caller-provided telemetry meta for batch processing", async () => {
    const env = createEnv({
      ENVIRONMENT: "dev-stage",
      DEPLOY_VERSION: "dev-version",
    });
    const message = createMessage<WebhookQueueMessage>({
      version: 2,
      provider: "github",
      ingress: "provider-webhook",
      requestId: "req-preserve-meta",
      receivedAt: "2026-05-19T00:00:00Z",
      headers: {},
      payload: {
        storage: "inline",
        body: "{}",
        sizeBytes: 2,
        sha256: "hash",
      },
      dedupe: {
        kind: "provider-delivery",
        provider: "github",
      },
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await processWebhookQueueBatch(
        {
          messages: [message],
          queue: "webhook-events",
          metadata: {} as MessageBatch["metadata"],
          retryAll: vi.fn(),
          ackAll: vi.fn(),
        },
        env,
        {} as ExecutionContext,
        {
          processor: async () => "ack",
          telemetryMeta: {
            service: "webhook-worker",
            environment: "caller-stage",
            version: "caller-version",
          },
        },
      );

      const hopLog = infoSpy.mock.calls.find((call) => {
        const payload = call[1] as Record<string, unknown> | undefined;
        return payload?.area === "nango-webhook-path" && payload.requestId === "req-preserve-meta";
      });
      expect(hopLog?.[1]).toMatchObject({
        environment: "caller-stage",
        version: "caller-version",
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("forwards queued nango messages to the cloud-web webhook route before acking", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage(createNangoSyncQueueMessage({
      headers: {
        "content-type": "application/json",
        "host": "agentrelay.com",
        "x-nango-hmac-sha256": "signature",
      },
      payload: {
        storage: "inline",
        body: "{\"type\":\"sync\",\"from\":\"confluence-relay\"}",
        sizeBytes: 42,
        sha256: "hash",
      },
    }));

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://origin.agentrelay.com/cloud/api/v1/webhooks/nango");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{\"type\":\"sync\",\"from\":\"confluence-relay\"}");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Headers;
    expect(headers.get("x-nango-hmac-sha256")).toBe("signature");
    expect(headers.get("x-cloud-webhook-worker-forwarded")).toBe("webhook-worker");
    expect(headers.get("x-cloud-webhook-worker-request-id")).toBe("req-1");
    expect(headers.get("host")).toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(store.completed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
    expect(store.failed).toHaveLength(0);
  });

  it("forwards queued nango-forward messages to cloud-web nango route before acking", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const rawBody = JSON.stringify({
      type: "forward",
      from: "github-app-oauth",
      connectionId: "conn-forward-1",
      providerConfigKey: "github-relay",
      payload: {
        action: "created",
        issue: { number: 42 },
      },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage(createNangoForwardQueueMessage({
      headers: {
        "content-type": "application/json",
        "host": "agentrelay.com",
        "x-nango-hmac-sha256": "signature",
      },
      payload: {
        storage: "inline",
        body: rawBody,
        sizeBytes: rawBody.length,
        sha256: "hash",
      },
    }));

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://origin.agentrelay.com/cloud/api/v1/webhooks/nango");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(rawBody);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Headers;
    expect(headers.get("x-nango-hmac-sha256")).toBe("signature");
    expect(headers.get("x-cloud-webhook-worker-forwarded")).toBe("webhook-worker");
    expect(headers.get("x-cloud-webhook-worker-request-id")).toBe("req-forward");
    expect(headers.get("host")).toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acks a poison missing-R2 payload without blocking later batch messages", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const poison = createMessage(createNangoForwardQueueMessage({
      requestId: "req-poison",
      payload: {
        storage: "r2",
        bucket: "WEBHOOK_PAYLOADS",
        key: "missing-payload.json",
        sizeBytes: 42,
        sha256: "0".repeat(64),
      },
    }), "msg-poison");
    const healthy = createMessage(createNangoForwardQueueMessage({
      requestId: "req-healthy",
      payload: {
        storage: "inline",
        body: "{\"type\":\"forward\",\"from\":\"github-app-oauth\"}",
        sizeBytes: 43,
        sha256: "hash",
      },
    }), "msg-healthy");

    await expect(worker.queue(
      {
        messages: [poison, healthy],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
    )).resolves.toBeUndefined();

    expect(poison.ack).toHaveBeenCalledOnce();
    expect(poison.retry).not.toHaveBeenCalled();
    expect(healthy.ack).toHaveBeenCalledOnce();
    expect(healthy.retry).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)
      .toBe("{\"type\":\"forward\",\"from\":\"github-app-oauth\"}");
  });

  it("acks a poison R2 sha mismatch without rethrowing the batch", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    await env.WEBHOOK_PAYLOADS.put("corrupt-payload.json", "{\"ok\":true}");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const poison = createMessage(createNangoForwardQueueMessage({
      requestId: "req-corrupt",
      payload: {
        storage: "r2",
        bucket: "WEBHOOK_PAYLOADS",
        key: "corrupt-payload.json",
        sizeBytes: 11,
        sha256: "f".repeat(64),
      },
    }), "msg-corrupt");

    await expect(worker.queue(
      {
        messages: [poison],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
    )).resolves.toBeUndefined();

    expect(poison.ack).toHaveBeenCalledOnce();
    expect(poison.retry).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a timed-out R2 payload stream", async () => {
    vi.useFakeTimers();
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      async pull() {
        await new Promise(() => {});
      },
      cancel,
    });
    env.WEBHOOK_PAYLOADS = {
      async get() {
        return { body: stream };
      },
    } as unknown as typeof env.WEBHOOK_PAYLOADS;
    const message = createMessage(createNangoForwardQueueMessage({
      payload: {
        storage: "r2",
        bucket: "WEBHOOK_PAYLOADS",
        key: "slow-payload.json",
        sizeBytes: 42,
        sha256: "0".repeat(64),
      },
    }));

    try {
      const pending = expect(
        processWebhookQueueMessage(message, env, {} as ExecutionContext),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;

      expect(cancel).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains queued nango messages even after router rollback sends new traffic elsewhere", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(store.completed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
    expect(store.failed).toHaveLength(0);
  });

  it("does not ack a forwarded nango message until dedup completion is durable", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const completeFailure = new Error("d1 complete failed");
    class CompleteThrowingDedupStore extends QueueTestDedupStore {
      override async complete(key: DedupeKey): Promise<void> {
        this.completed.push(key);
        throw completeFailure;
      }
    }
    const store = new CompleteThrowingDedupStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    })));
    const message = createMessage(createNangoSyncQueueMessage());

    await expect(processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    )).rejects.toBe(completeFailure);

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(store.completed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
    expect(store.failed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
  });

  it("retries unsupported generic provider webhooks instead of acking accepted-but-unhandled work", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage<WebhookQueueMessage>({
      version: 2,
      provider: "composio",
      ingress: "provider-webhook",
      requestId: "req-composio",
      receivedAt: "2026-05-19T00:00:00Z",
      headers: {},
      payload: {
        storage: "inline",
        body: "{}",
        sizeBytes: 2,
        sha256: "hash",
      },
      dedupe: {
        kind: "provider-delivery",
        provider: "composio",
        deliveryId: "evt-1",
      },
    });

    await processWebhookQueueMessage(message, env, {} as ExecutionContext);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it("forwards integration-watch delivery drain messages to the internal drain route", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
      AGENT_GATEWAY_INTERNAL_SECRET: "gateway-key",
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage<WebhookQueueMessage>({
      version: 2,
      provider: "internal",
      ingress: "integration-watch-delivery-drain",
      requestId: "req-drain",
      receivedAt: "2026-07-01T00:00:00Z",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        storage: "inline",
        body: JSON.stringify({
          workspaceId: "workspace-1",
          agentId: "agent-1",
          deliveryId: "delivery-1",
        }),
        sizeBytes: 72,
        sha256: "hash",
      },
      delivery: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
      },
      dedupe: {
        kind: "integration-watch-delivery-drain",
        deliveryId: "delivery-1",
      },
    });

    await processWebhookQueueMessage(message, env, {} as ExecutionContext);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://origin.agentrelay.com/cloud/api/internal/proactive-runtime/integration-watch-deliveries/drain",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-agent-gateway-secret")).toBe("gateway-key");
    expect(String(init.body)).toContain("delivery-1");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries queued nango messages when cloud-web returns a transient rejection", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporary failure", {
      status: 502,
    })));
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(store.completed).toHaveLength(0);
    expect(store.failed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
  });

  it("retries queued nango-forward messages when the cloud-web forward times out", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("forward timed out", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage(createNangoForwardQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acks dedupable nango sync messages when cloud-web returns a permanent 400 client error", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "malformed payload" }),
      { status: 400 },
    )));
    const message = createMessage(createNangoSyncQueueMessage({
      payload: {
        storage: "inline",
        body: "{\"type\":\"event_callback\",\"event\":{}}",
        sizeBytes: 34,
        sha256: "hash",
      },
    }));

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(store.completed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
    expect(store.failed).toHaveLength(0);
  });

  it("acks queued nango-forward messages when cloud-web returns a permanent 422 payload error", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "unprocessable payload" }),
      { status: 422 },
    )));
    const message = createMessage(createNangoForwardQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("keeps 429 cloud-web rejections retryable", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
    })));
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(store.completed).toHaveLength(0);
    expect(store.failed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
  });

  it("claims stable nango sync deliveries and releases the claim when the consumer retries", async () => {
    const env = createEnv();
    const store = new QueueTestDedupStore();
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(store.claims).toHaveLength(1);
    expect(store.claims[0]).toMatchObject({
      surface: "nango-sync",
      connectionId: "conn-1",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      syncWindowKey: "2026-05-19T00:00:00Z",
      cursorKey: "cursor-1",
    });
    expect(store.completed).toHaveLength(0);
    expect(store.failed).toEqual([{
      surface: "nango-sync",
      dedupeId: store.claims[0].dedupeId,
    }]);
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acks completed duplicate nango sync deliveries without retrying", async () => {
    const env = createEnv();
    const key = {
      surface: "nango-sync" as const,
      dedupeId: "v1:completed",
    };
    const store = new QueueTestDedupStore({
      type: "duplicate_completed",
      key,
      completedAt: new Date("2026-05-19T00:00:00Z"),
    });
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(store.completed).toHaveLength(0);
    expect(store.failed).toHaveLength(0);
  });

  it("retries in-flight duplicate nango sync deliveries without processing", async () => {
    const env = createEnv();
    const key = {
      surface: "nango-sync" as const,
      dedupeId: "v1:in-flight",
    };
    const store = new QueueTestDedupStore({
      type: "duplicate_in_flight",
      key,
      leaseExpiresAt: new Date("2026-05-19T00:01:00Z"),
    });
    const message = createMessage(createNangoSyncQueueMessage());

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(store.completed).toHaveLength(0);
    expect(store.failed).toHaveLength(0);
  });

  it("uses the default D1 dedup store to suppress completed queue redeliveries", async () => {
    const d1 = (cloudflareEnv as typeof cloudflareEnv & { NANGO_SYNC_DEDUP: D1Database })
      .NANGO_SYNC_DEDUP;
    await d1.exec("DROP TABLE IF EXISTS nango_sync_dedup");

    const env = createEnv({ NANGO_SYNC_DEDUP: d1 });
    const body = createNangoSyncQueueMessage();
    const firstDelivery = createMessage(body);
    const redelivery = createMessage({
      ...body,
      requestId: "req-redelivery",
      receivedAt: "2026-05-19T00:00:10Z",
    });
    const providerWrites: string[] = [];
    const processor: NonNullable<QueueConsumerOptions["processor"]> =
      vi.fn(async (message) => {
        providerWrites.push(message.body?.requestId ?? "missing-request");
        message.ack();
        return "ack" as const;
      });

    await processWebhookQueueMessage(
      firstDelivery,
      env,
      {} as ExecutionContext,
      { processor },
    );
    await processWebhookQueueMessage(
      redelivery,
      env,
      {} as ExecutionContext,
      { processor },
    );

    expect(providerWrites).toEqual(["req-1"]);
    expect(processor).toHaveBeenCalledOnce();
    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    expect(firstDelivery.retry).not.toHaveBeenCalled();
    expect(redelivery.ack).toHaveBeenCalledOnce();
    expect(redelivery.retry).not.toHaveBeenCalled();
  });

  it("serializes same-dedupe-key messages inside a parallel batch", async () => {
    const env = createEnv();
    const store = new StatefulQueueTestDedupStore();
    const firstDelivery = createMessage(createNangoSyncQueueMessage(), "msg-sync-1");
    const duplicateDelivery = createMessage(createNangoSyncQueueMessage({
      requestId: "req-duplicate",
    }), "msg-sync-2");
    let activeProcessors = 0;
    let maxActiveProcessors = 0;
    const processedMessageIds: string[] = [];
    const processor: NonNullable<QueueConsumerOptions["processor"]> =
      vi.fn(async (message) => {
        activeProcessors += 1;
        maxActiveProcessors = Math.max(maxActiveProcessors, activeProcessors);
        processedMessageIds.push(message.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        message.ack();
        activeProcessors -= 1;
        return "ack" as const;
      });

    await processWebhookQueueBatch(
      {
        messages: [firstDelivery, duplicateDelivery],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
      { dedupStore: store, processor },
    );

    expect(processedMessageIds).toEqual(["msg-sync-1"]);
    expect(maxActiveProcessors).toBe(1);
    expect(processor).toHaveBeenCalledOnce();
    expect(store.claims).toHaveLength(2);
    expect(store.completed).toHaveLength(1);
    expect(store.failed).toHaveLength(0);
    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    expect(firstDelivery.retry).not.toHaveBeenCalled();
    expect(duplicateDelivery.ack).toHaveBeenCalledOnce();
    expect(duplicateDelivery.retry).not.toHaveBeenCalled();
  });

  it("forwards gitlab-hookdeck messages to cloud-web hookdeck without nango signatures", async () => {
    const env = createEnv({
      CLOUD_WEB_WEBHOOK_ORIGIN: "https://origin.agentrelay.com",
    });
    const store = new QueueTestDedupStore();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const message = createMessage(createGitLabHookdeckQueueMessage({
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": "Merge Request Hook",
        "x-gitlab-event-uuid": "evt-1",
        "x-hookdeck-signature": "hookdeck-signature",
        "x-nango-hmac-sha256": "nango-signature",
        "x-nango-signature": "legacy-nango-signature",
      },
      payload: {
        storage: "inline",
        body: "{\"object_kind\":\"merge_request\"}",
        sizeBytes: 31,
        sha256: "hash",
      },
    }));

    await processWebhookQueueMessage(
      message,
      env,
      {} as ExecutionContext,
      { dedupStore: store },
    );

    expect(store.claims).toHaveLength(1);
    expect(store.claims[0]).toMatchObject({
      surface: "gitlab-hookdeck-delivery",
      dedupeId: "v1:evt-1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://origin.agentrelay.com/cloud/api/v1/webhooks/hookdeck");
    expect(init.body).toBe("{\"object_kind\":\"merge_request\"}");
    const headers = init.headers as Headers;
    expect(headers.get("x-hookdeck-signature")).toBe("hookdeck-signature");
    expect(headers.get("x-gitlab-event")).toBe("Merge Request Hook");
    expect(headers.get("x-nango-hmac-sha256")).toBeNull();
    expect(headers.get("x-nango-signature")).toBeNull();
    expect(store.completed).toEqual([{
      surface: "gitlab-hookdeck-delivery",
      dedupeId: "v1:evt-1",
    }]);
    expect(store.failed).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("rejects unsupported provider ingress paths at the worker boundary", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://worker.test/api/v1/webhooks/composio", {
        method: "POST",
        body: "{}",
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(0);
  });

  it("acks legacy v1 messages as unprocessable", async () => {
    const env = createEnv();
    const message = createMessage<LegacyWebhookQueueMessage>({
      provider: "nango",
      body: "{}",
      headers: {},
      requestId: "req-legacy",
      receivedAt: "2026-05-19T00:00:00Z",
    });

    await worker.queue(
      {
        messages: [message],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("logs and acks webhook-events DLQ messages without replaying them", async () => {
    const env = createEnv();
    const message = createMessage(createNangoForwardQueueMessage(), "msg-dlq");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await worker.queue(
        {
          messages: [message],
          queue: "webhook-events-dlq-production",
          metadata: {} as MessageBatch["metadata"],
          retryAll: vi.fn(),
          ackAll: vi.fn(),
        },
        env,
        {} as ExecutionContext,
      );

      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) =>
        String(call[0]).includes("webhook_events_dlq_dead_letter"),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("acks falsy malformed bodies without throwing or retrying the batch", async () => {
    const env = createEnv();
    const message = createMessage(null);

    const malformedMessage = message as unknown as Message<
      WebhookQueueMessage | LegacyWebhookQueueMessage
    >;

    await expect(worker.queue(
      {
        messages: [malformedMessage],
        queue: "webhook-events",
        metadata: {} as MessageBatch["metadata"],
        retryAll: vi.fn(),
        ackAll: vi.fn(),
      },
      env,
      {} as ExecutionContext,
    )).resolves.toBeUndefined();

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("surfaces the dedup store's drizzle cause + PG code via the per-hop log (#743 regression guard)", async () => {
    const env = createEnv();

    // Drizzle-shaped error: outer wrapper carries the SQL context, inner
    // cause carries the actionable PG code. Pre-#743-fix the consumer's
    // `console.error(error.message)` would have logged only "Failed query".
    const pgError = new Error("relation \"nango_sync_dedup\" does not exist");
    Object.assign(pgError, {
      name: "PostgresError",
      code: "42P01",
      table: "nango_sync_dedup",
      severity: "ERROR",
    });
    const drizzleErr = new Error("Failed query: INSERT INTO nango_sync_dedup", {
      cause: pgError,
    });

    const throwingStore: NangoSyncDedupStore = {
      claim: async () => {
        throw drizzleErr;
      },
      complete: async () => {},
      fail: async () => {},
    };

    const message = createMessage(createNangoSyncQueueMessage());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        processWebhookQueueMessage(message, env, {} as ExecutionContext, {
          dedupStore: throwingStore,
        }),
      ).rejects.toBe(drizzleErr);

      // Find the structured hop error log — `area === "nango-webhook-path"`
      // is the canonical CloudWatch filter introduced by B4-OBS.
      const hopErrorCalls = errorSpy.mock.calls.filter((call) => {
        const payload = call[1] as Record<string, unknown> | undefined;
        return payload?.area === "nango-webhook-path" && payload?.outcome === "error";
      });
      expect(hopErrorCalls.length).toBeGreaterThanOrEqual(1);

      const payload = hopErrorCalls[0][1] as Record<string, unknown>;
      // Non-vacuous gate: PG code MUST be present, non-empty, and equal to
      // the inner cause's code — not "undefined", not "" — proving the
      // chain walker pulled it through the drizzle wrapper.
      expect(payload.errorCode).toBe("42P01");
      expect(typeof payload.errorCode === "string").toBe(true);
      expect((payload.errorCode as string).length).toBeGreaterThan(0);
      // The wrapper message stays surfaced too (so we don't lose context).
      expect(payload.errorMessage).toBe(
        "Failed query: INSERT INTO nango_sync_dedup",
      );
      // And the deeper PG frame is in the chain at index 1.
      const chain = payload.errorCauseChain as Array<Record<string, unknown>>;
      expect(chain.length).toBeGreaterThanOrEqual(2);
      expect(chain[1]?.code).toBe("42P01");
      expect(chain[1]?.table).toBe("nango_sync_dedup");
      // Correlation IDs surfaced at the consume boundary.
      expect(payload.requestId).toBe("req-1");
      expect(payload.provider).toBe("nango");
      expect(payload.hop).toBe("dedup");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
