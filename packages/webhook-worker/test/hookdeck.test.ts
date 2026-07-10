import { describe, expect, it } from "vitest";
import { handle } from "../src/handlers/hookdeck";
import { createEnv, readJson, signHookdeck, signNangoHmac } from "./helpers";

describe("hookdeck webhook handler", () => {
  it("accepts valid hookdeck and nango signatures", async () => {
    const env = createEnv();
    const body = JSON.stringify({ type: "sync", from: "github", payload: { ok: true } });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/hookdeck", {
        method: "POST",
        headers: {
          "x-hookdeck-signature": signHookdeck(body, env.HOOKDECK_WEBHOOK_SECRET!),
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
      provider: "hookdeck",
      ingress: "provider-webhook",
    });
  });

  it("rejects an invalid signature", async () => {
    const env = createEnv();
    const body = JSON.stringify({ type: "sync", from: "github" });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/hookdeck", {
        method: "POST",
        headers: {
          "x-hookdeck-signature": "bad",
          "x-nango-hmac-sha256": signNangoHmac(body, env.NANGO_WEBHOOK_SECRET!),
        },
        body,
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
    expect(env.WEBHOOK_QUEUE.sent).toHaveLength(0);
  });

  it("rejects a missing hookdeck signature header", async () => {
    const env = createEnv();
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/hookdeck", {
        method: "POST",
        headers: {
          "x-nango-hmac-sha256": signNangoHmac("{\"type\":\"sync\",\"from\":\"github\"}", env.NANGO_WEBHOOK_SECRET!),
        },
        body: "{\"type\":\"sync\",\"from\":\"github\"}",
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
  });
});
