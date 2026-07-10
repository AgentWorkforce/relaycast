import { describe, expect, it } from "vitest";
import { handle } from "../src/handlers/github";
import { createEnv, readJson, signGitHub } from "./helpers";

describe("github webhook handler", () => {
  it("accepts a valid signature", async () => {
    const env = createEnv();
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": signGitHub(body, env.GITHUB_WEBHOOK_SECRET!),
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
      provider: "github",
      ingress: "provider-webhook",
    });
  });

  it("rejects an invalid signature", async () => {
    const env = createEnv();
    const response = await handle(
      new Request("https://example.com/api/v1/webhooks/github", {
        method: "POST",
        headers: {
          "x-hub-signature-256": "sha256=bad",
        },
        body: "{\"ok\":true}",
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
      new Request("https://example.com/api/v1/webhooks/github", {
        method: "POST",
        body: "{\"ok\":true}",
      }),
      env,
    );

    expect(response.status).toBe(401);
    await expect(readJson<{ error: string }>(response)).resolves.toEqual({ error: "invalid_signature" });
  });
});
