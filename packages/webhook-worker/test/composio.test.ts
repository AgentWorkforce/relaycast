import { describe, expect, it } from "vitest";
import { handle } from "../src/handlers/composio";
import { createEnv, readJson, signComposio } from "./helpers";

describe("composio webhook handler", () => {
  it("accepts a valid signature", async () => {
    const env = createEnv();
    const webhookId = "wh_123";
    const webhookTimestamp = String(Math.trunc(Date.now() / 1000));
    const body = JSON.stringify({
      id: "msg_123",
      type: "composio.trigger.message",
      metadata: { trigger_slug: "GITHUB_COMMIT_EVENT" },
      data: { ok: true },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/composio", {
        method: "POST",
        headers: {
          "webhook-id": webhookId,
          "webhook-signature": signComposio(
            webhookId,
            webhookTimestamp,
            body,
            env.COMPOSIO_WEBHOOK_SECRET!,
          ),
          "webhook-timestamp": webhookTimestamp,
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
      provider: "composio",
      ingress: "provider-webhook",
    });
  });

  it("rejects an invalid signature", async () => {
    const env = createEnv();
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/composio", {
        method: "POST",
        headers: {
          "webhook-id": "wh_123",
          "webhook-signature": "bad",
          "webhook-timestamp": String(Math.trunc(Date.now() / 1000)),
        },
        body: "{\"id\":\"msg_123\"}",
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
      new Request("https://example.com/api/v1/webhooks/composio", {
        method: "POST",
        headers: {
          "webhook-id": "wh_123",
          "webhook-timestamp": String(Math.trunc(Date.now() / 1000)),
        },
        body: "{\"id\":\"msg_123\"}",
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
  });

  it("rejects a replayed timestamp outside the tolerance window", async () => {
    const env = createEnv();
    const webhookId = "wh_123";
    const webhookTimestamp = String(Math.trunc(Date.now() / 1000) - 601);
    const body = JSON.stringify({
      id: "msg_123",
      type: "composio.trigger.message",
      metadata: { trigger_slug: "GITHUB_COMMIT_EVENT" },
      data: { ok: true },
    });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/composio", {
        method: "POST",
        headers: {
          "webhook-id": webhookId,
          "webhook-signature": signComposio(
            webhookId,
            webhookTimestamp,
            body,
            env.COMPOSIO_WEBHOOK_SECRET!,
          ),
          "webhook-timestamp": webhookTimestamp,
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
  });
});
