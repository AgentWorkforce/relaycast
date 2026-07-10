import { describe, expect, it, vi } from "vitest";

import worker from "../index.js";

type StoredEntry = { value: string };

class MemoryKV {
  readonly store = new Map<string, StoredEntry>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, { value });
  }
}

function asKV(kv: MemoryKV): KVNamespace {
  return kv as unknown as KVNamespace;
}

type WorkerBinding = { fetch: ReturnType<typeof vi.fn> };

function makeBinding(): WorkerBinding {
  return {
    fetch: vi.fn(async () => new Response("ok", { status: 200 })),
  };
}

function buildEnv(opts: {
  webhookOriginFlag?: string;
  cloudWebWorker?: WorkerBinding;
  webhookWorker?: WorkerBinding;
  relayfileCloudWorker?: WorkerBinding;
  relayfileCloudOrigin?: string;
}) {
  const routerConfig = new MemoryKV();
  if (opts.webhookOriginFlag !== undefined) {
    routerConfig.store.set("WEBHOOK_ORIGIN", { value: opts.webhookOriginFlag });
  }
  return {
    CLOUD_APP_ORIGIN: "https://origin.test.invalid",
    ROUTER_CONFIG: asKV(routerConfig),
    CLOUD_WEB_WORKER: opts.cloudWebWorker,
    WEBHOOK_WORKER: opts.webhookWorker,
    RELAYFILE_CLOUD_WORKER: opts.relayfileCloudWorker,
    RELAYFILE_CLOUD_ORIGIN: opts.relayfileCloudOrigin,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function buildCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

describe("router webhook routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes /api/v1/webhooks/nango to the webhook-worker binding when WEBHOOK_ORIGIN=worker", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.com/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(webhookWorker.fetch).toHaveBeenCalledOnce();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();
  });

  it("routes allowlisted non-lifecycle /api/v1/webhooks/nango to the relayfile-cloud binding when WEBHOOK_ORIGIN=relayfile-cloud", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      webhookWorker,
      relayfileCloudWorker,
    });

    const rawBody = '{ "type": "webhook", "from": "github-relay", "payload": { "id": 1 } }';
    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango?delivery=1",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nango-hmac-sha256": "sig-v2",
          "x-hookdeck-request-id": "hd-req-1",
        },
        body: rawBody,
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(relayfileCloudWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();

    const forwardedRequest = relayfileCloudWorker.fetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe("/v1/nango/webhook");
    expect(forwardedUrl.search).toBe("?delivery=1");
    expect(forwardedRequest.headers.get("content-type")).toBe("application/json");
    expect(forwardedRequest.headers.get("x-nango-hmac-sha256")).toBe("sig-v2");
    expect(forwardedRequest.headers.get("x-hookdeck-request-id")).toBe("hd-req-1");
    expect(
      forwardedRequest.headers.get("x-cloud-webhook-relayfile-cloud-forwarded"),
    ).toBe("relayfile-cloud");
    await expect(forwardedRequest.text()).resolves.toBe(rawBody);
  });

  it("routes /api/v1/webhooks/nango to the relayfile-cloud origin fallback when no binding is present", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const fetchMock = vi.fn(async (_request: Request) =>
      new Response("relayfile-origin", { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      webhookWorker,
      relayfileCloudOrigin: "https://dev.file.agentrelay.com",
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango?delivery=2",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nango-signature": "legacy-sig",
          "x-hookdeck-eventid": "hd-event-2",
        },
        body: JSON.stringify({ type: "webhook", from: "linear-relay" }),
      },
    );

    const response = await worker.fetch(request, env, buildCtx());

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();

    const forwardedRequest = fetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.origin).toBe("https://dev.file.agentrelay.com");
    expect(forwardedUrl.pathname).toBe("/v1/nango/webhook");
    expect(forwardedUrl.search).toBe("?delivery=2");
    expect(forwardedRequest.headers.get("x-nango-signature")).toBe("legacy-sig");
    expect(forwardedRequest.headers.get("x-hookdeck-eventid")).toBe("hd-event-2");
    expect(
      forwardedRequest.headers.get("x-cloud-webhook-relayfile-cloud-forwarded"),
    ).toBe("relayfile-cloud");
    await expect(forwardedRequest.json()).resolves.toEqual({
      type: "webhook",
      from: "linear-relay",
    });
  });

  it("keeps Nango auth lifecycle events on cloud-web when WEBHOOK_ORIGIN=relayfile-cloud", async () => {
    const cloudWebWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      relayfileCloudWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "auth",
          providerConfigKey: "github-relay",
          connectionId: "conn_auth_1",
        }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("keeps Nango connection.created lifecycle events on cloud-web from alternate event type fields", async () => {
    const cloudWebWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      relayfileCloudWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_type: "connection.created",
          provider_config_key: "slack-relay",
          connection_id: "conn_created_1",
        }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("keeps malformed or unknown Nango webhook types on cloud-web as a fail-safe", async () => {
    const cloudWebWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      relayfileCloudWorker,
    });

    const malformed = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );
    const unknown = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "mystery", from: "github-relay" }),
      },
    );

    await worker.fetch(malformed, env, buildCtx());
    await worker.fetch(unknown, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledTimes(2);
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("keeps non-allowlisted Nango provider config keys on cloud-web", async () => {
    const cloudWebWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      relayfileCloudWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "webhook", from: "slack-ricky" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when WEBHOOK_ORIGIN=relayfile-cloud but no relayfile-cloud target is configured", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "webhook", from: "notion-relay" }),
      },
    );

    const response = await worker.fetch(request, env, buildCtx());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "relayfile-cloud worker binding unavailable",
    });
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();
  });

  it("bypasses relayfile-cloud when request carries relayfile-cloud forwarded header (loop break)", async () => {
    const cloudWebWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      relayfileCloudWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-relayfile-cloud-forwarded": "relayfile-cloud",
        },
        body: JSON.stringify({ type: "callback", from: "relayfile-cloud" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("bypasses relayfile-cloud when request carries webhook-worker forwarded header", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const relayfileCloudWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "relayfile-cloud",
      cloudWebWorker,
      webhookWorker,
      relayfileCloudWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-worker-forwarded": "webhook-worker",
        },
        body: JSON.stringify({ type: "forward", from: "webhook-worker" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
    expect(relayfileCloudWorker.fetch).not.toHaveBeenCalled();
  });

  it("bypasses webhook-worker when request carries x-cloud-webhook-worker-forwarded header (loop break)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.com/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-worker-forwarded": "webhook-worker",
          "x-cloud-webhook-worker-request-id": "req-loop-1",
        },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
  });

  it("ignores the loop-break header for an unrelated value (don't accidentally widen bypass)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.com/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-worker-forwarded": "something-else",
        },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(webhookWorker.fetch).toHaveBeenCalledOnce();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();
  });

  it("routes to cloud-web when WEBHOOK_ORIGIN flag is unset (regression: still works without flag)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.com/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
  });
});
