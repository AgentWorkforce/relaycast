/**
 * Generic concurrency-lease Durable Object (issue #1384 slice 3c / #1449).
 *
 * Thin Cloudflare Durable Object wrapper around `LeaseStore`. One DO instance
 * per lease pool (the consumer addresses it via `idFromName(poolId)`), so this
 * class itself is pool-agnostic — it just manages its own lease set.
 *
 * Modeled on the relaycron `SchedulerDO` convention (`implements DurableObject`
 * shape, fetch-RPC, `state.storage`, `alarm()`). Like the rest of the web
 * package it avoids a hard `@cloudflare/workers-types` dependency and declares
 * the minimal DO surface it uses; the deployed Worker provides the real types.
 *
 * Binding/infra wiring is intentionally deferred to the consumers (#1384 3c
 * warm-consumer Worker and #1449), so this module ships dormant.
 */
import { LeaseStore, type LeaseStorage } from "./lease-store.js";

interface DurableObjectStateLike {
  storage: LeaseStorage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type LeaseOp = "acquire" | "renew" | "release" | "count";

export class ConcurrencyLeaseDO {
  private readonly store: LeaseStore;

  constructor(state: DurableObjectStateLike, _env?: unknown) {
    this.store = new LeaseStore(state.storage);
  }

  async fetch(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "invalid json body" }, 400);
    }

    const op = body.op as LeaseOp | undefined;
    switch (op) {
      case "acquire":
        return jsonResponse(
          await this.store.acquire({
            leaseKey: String(body.leaseKey),
            cap: Number(body.cap),
            ttlMs: Number(body.ttlMs),
            meta: body.meta as Record<string, string> | undefined,
          }),
        );
      case "renew":
        return jsonResponse(
          await this.store.renew({
            leaseKey: String(body.leaseKey),
            ttlMs: Number(body.ttlMs),
            leaseId: body.leaseId as string | undefined,
          }),
        );
      case "release":
        return jsonResponse(
          await this.store.release({
            leaseKey: String(body.leaseKey),
            leaseId: body.leaseId as string | undefined,
          }),
        );
      case "count":
        return jsonResponse(await this.store.currentActiveCount());
      default:
        return jsonResponse({ error: `unknown op: ${String(op)}` }, 400);
    }
  }

  async alarm(): Promise<void> {
    await this.store.sweep();
  }
}
