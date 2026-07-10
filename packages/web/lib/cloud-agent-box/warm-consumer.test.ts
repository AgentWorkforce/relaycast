import { describe, expect, it, vi } from "vitest";

import warmConsumer from "./warm-consumer";

function makeMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function makeEnv(fetchImpl: (req: Request) => Promise<Response>) {
  return { CLOUD_WEB: { fetch: vi.fn(fetchImpl) }, BROKER_HMAC_SECRET: "test-secret" };
}

describe("cloud-agent warm consumer Worker (thin forwarder)", () => {
  it("forwards a step to cloud-web with bearer auth and acks on 2xx", async () => {
    const env = makeEnv(async () => new Response(null, { status: 200 }));
    const m = makeMessage(JSON.stringify({ jobId: "j1", expectedStep: "ensure-sandbox" }));
    await warmConsumer.queue({ queue: "cloud-agent-warm-production", messages: [m] }, env as never);
    expect(env.CLOUD_WEB.fetch).toHaveBeenCalledTimes(1);
    const req = (env.CLOUD_WEB.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    // Must carry the cloud-web basePath "/cloud" — a service-binding fetch
    // bypasses the public router, so the worker (Next basePath /cloud) needs it.
    expect(req.url).toContain("/cloud/api/v1/internal/cloud-agent-warm/step");
    expect(req.headers.get("authorization")).toBe("Bearer test-secret");
    expect(await req.json()).toEqual({ jobId: "j1", expectedStep: "ensure-sandbox" });
    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
  });

  it("retries on a non-2xx response", async () => {
    const env = makeEnv(async () => new Response("boom", { status: 503 }));
    const m = makeMessage(JSON.stringify({ jobId: "j1", expectedStep: "ensure-sandbox" }));
    await warmConsumer.queue({ queue: "cloud-agent-warm-production", messages: [m] }, env as never);
    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.ack).not.toHaveBeenCalled();
  });

  it("flags dlq:true when consuming the dead-letter queue", async () => {
    const env = makeEnv(async () => new Response(null, { status: 200 }));
    const m = makeMessage(JSON.stringify({ jobId: "j1", expectedStep: "ensure-broker" }));
    await warmConsumer.queue({ queue: "cloud-agent-warm-dlq-production", messages: [m] }, env as never);
    const req = (env.CLOUD_WEB.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    expect(await req.json()).toEqual({ jobId: "j1", expectedStep: "ensure-broker", dlq: true });
    expect(m.ack).toHaveBeenCalledTimes(1);
  });

  it("acks (drops) an unparseable message without calling cloud-web", async () => {
    const env = makeEnv(async () => new Response(null, { status: 200 }));
    const m = makeMessage("not-json");
    await warmConsumer.queue({ queue: "cloud-agent-warm-production", messages: [m] }, env as never);
    expect(env.CLOUD_WEB.fetch).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalledTimes(1);
  });
});
