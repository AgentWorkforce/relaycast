import { describe, expect, it, vi } from "vitest";
import { handle } from "../src/handlers/nango";
import { createEnv, readJson, signNangoHmac } from "./helpers";

describe("nango webhook handler", () => {
  it("accepts a valid hmac signature", async () => {
    const env = createEnv();
    const body = JSON.stringify({ type: "sync", from: "github", payload: { ok: true } });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(readJson<{ accepted: true; queue: string; messageId: string }>(response)).resolves.toMatchObject({
      accepted: true,
      queue: "webhook-events",
    });
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(1);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      version: 2,
      provider: "nango",
      ingress: "nango-sync",
      nango: {
        envelopeType: "sync",
        from: "github",
      },
      dedupe: {
        kind: "nango-sync",
      },
    });
  });

  it("enqueues forward envelopes as nango-forward messages", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "forward",
      from: "github-app-oauth",
      connectionId: "conn-forward-1",
      providerConfigKey: "github-relay",
      payload: {
        action: "created",
        issue: { number: 42 },
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
          "x-nango-delivery-id": "delivery-1",
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(1);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      version: 2,
      provider: "nango",
      ingress: "nango-forward",
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
    });
    expect(env.WEBHOOK_QUEUE.sent[0]?.payload).toMatchObject({
      storage: "inline",
      body,
    });
  });

  it("infers Slack relay forwards without a Nango provider identifier", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "forward",
      connectionId: "conn-slack-forward-1",
      payload: {
        token: "verification-token",
        team_id: "T123",
        api_app_id: "A123",
        type: "event_callback",
        event: {
          type: "message",
          channel: "D123",
          ts: "1780689000.000100",
          text: "dm probe",
          user: "U123",
        },
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
          "x-slack-signature": "v0=test",
          "x-slack-request-timestamp": "1780689000",
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(1);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      version: 2,
      provider: "nango",
      ingress: "nango-forward",
      nango: {
        envelopeType: "forward",
        from: "slack-relay",
        connectionId: "conn-slack-forward-1",
        providerConfigKey: "slack-relay",
      },
      dedupe: {
        kind: "nango-forward",
        connectionId: "conn-slack-forward-1",
      },
    });
  });

  it("does not infer Slack relay from payload shape without forwarded Slack signature headers", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "forward",
      connectionId: "conn-slack-shaped-1",
      payload: {
        type: "event_callback",
        event: {
          type: "message",
          channel: "D123",
          ts: "1780689000.000100",
          text: "dm probe",
          user: "U123",
        },
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(readJson<{ accepted: true; dropped: true; reason: string }>(response)).resolves.toEqual({
      accepted: true,
      dropped: true,
      reason: "missing_nango_provider_identifier",
    });
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(0);
  });

  it("continues to enqueue sync envelopes as nango-sync messages", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "sync",
      from: "github",
      payload: {
        connectionId: "conn-sync-1",
        syncName: "issues",
        model: "GitHubIssue",
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      version: 2,
      provider: "nango",
      ingress: "nango-sync",
      nango: {
        envelopeType: "sync",
        from: "github",
        connectionId: "conn-sync-1",
        syncName: "issues",
        model: "GitHubIssue",
      },
      dedupe: {
        kind: "nango-sync",
        connectionId: "conn-sync-1",
        syncName: "issues",
        model: "GitHubIssue",
      },
    });
  });

  it("accepts provider as the Nango provider identifier", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "sync",
      provider: "github",
      payload: {
        connectionId: "conn-sync-provider",
        syncName: "issues",
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(1);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      ingress: "nango-sync",
      nango: {
        from: "github",
        providerConfigKey: "github",
        connectionId: "conn-sync-provider",
        syncName: "issues",
      },
    });
  });

  it("accepts payload.from as the Nango provider identifier", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "sync",
      payload: {
        from: "linear",
        connectionId: "conn-sync-payload-from",
        syncName: "issues",
      },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(1);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      ingress: "nango-sync",
      nango: {
        from: "linear",
        providerConfigKey: "linear",
        connectionId: "conn-sync-payload-from",
        syncName: "issues",
      },
    });
  });

  it("drops malformed Nango envelopes without a provider identifier before enqueue", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      type: "sync",
      payload: {
        connectionId: "conn-missing-provider",
        syncName: "issues",
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(readJson<{ accepted: true; dropped: true; reason: string }>(response)).resolves.toEqual({
      accepted: true,
      dropped: true,
      reason: "missing_nango_provider_identifier",
    });
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(0);
    expect(env.WEBHOOK_PAYLOADS.objects.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[webhook-worker/ingest] nango_ingest_dropped_malformed",
      expect.objectContaining({
        connectionId: "conn-missing-provider",
        syncName: "issues",
        reason: "missing_nango_provider_identifier",
      }),
    );
    warnSpy.mockRestore();
  });

  it("enqueues GitLab Hookdeck-shaped messages on the shared nango endpoint", async () => {
    const env = createEnv();
    const body = JSON.stringify({
      object_kind: "push",
      project: { id: 12345 },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
          "x-gitlab-event": "Push Hook",
          "x-gitlab-event-uuid": "gitlab-event-1",
          "x-gitlab-token": "project-token",
          "x-hookdeck-signature": "hookdeck-sig",
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(env.WEBHOOK_QUEUE.sent[0]).toMatchObject({
      version: 2,
      provider: "nango",
      ingress: "gitlab-hookdeck",
      gitlab: {
        event: "Push Hook",
        eventUuid: "gitlab-event-1",
        token: "project-token",
        projectId: "12345",
      },
      hookdeck: {
        signature: "hookdeck-sig",
      },
      dedupe: {
        kind: "gitlab-hookdeck-delivery",
        deliveryId: "gitlab-event-1",
      },
    });
  });

  it("offloads large webhook bodies to R2 before enqueueing", async () => {
    const env = createEnv();
    const body = JSON.stringify({ type: "sync", from: "github", data: "x".repeat(98 * 1024) });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    const message = env.WEBHOOK_QUEUE.sent[0];
    expect(message?.payload.storage).toBe("r2");
    if (message?.payload.storage === "r2") {
      expect(env.WEBHOOK_PAYLOADS.objects.get(message.payload.key)).toBe(body);
    }
  });

  it("ignores caller-supplied request IDs when storing large payloads", async () => {
    const env = createEnv();
    const callerRequestId = "caller-controlled-request-id";
    const body = JSON.stringify({ type: "sync", from: "github", data: "x".repeat(98 * 1024) });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-cloud-webhook-worker-request-id": callerRequestId,
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(202);
    const message = env.WEBHOOK_QUEUE.sent[0];
    expect(message?.requestId).toMatch(/^req_/);
    expect(message?.requestId).not.toBe(callerRequestId);
    expect(message?.payload.storage).toBe("r2");
    if (message?.payload.storage === "r2") {
      expect(message.payload.key).toContain(`/${message.requestId}.body`);
      expect(message.payload.key).not.toContain(callerRequestId);
    }
  });

  it("rejects an invalid signature", async () => {
    const env = createEnv();
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": "bad",
        },
        body: "{\"type\":\"sync\",\"from\":\"github\"}",
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(0);
  });

  it("rejects a missing signature header", async () => {
    const env = createEnv();
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/nango", {
        method: "POST",
        body: "{\"type\":\"sync\",\"from\":\"github\"}",
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
  });
});
