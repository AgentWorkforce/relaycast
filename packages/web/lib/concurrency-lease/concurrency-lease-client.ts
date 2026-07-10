/**
 * Client for the generic concurrency-lease Durable Object.
 *
 * Wraps a DO namespace binding so consumers (the #1384 3c warm-consumer Worker
 * and #1449) call `acquire/renew/release/currentActiveCount` without
 * hand-rolling the fetch-RPC. `poolId` selects the pool DO instance via
 * `idFromName`; the cap VALUE/SCOPE is the caller's (see `config.ts`).
 *
 * Minimal local DO-namespace types keep the web package free of a hard
 * `@cloudflare/workers-types` dependency (same convention as `warm-consumer.ts`).
 */
import type {
  AcquireResult,
  CountResult,
  ReleaseResult,
  RenewResult,
} from "./lease-store.js";

interface DurableObjectStubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

// The pool DO ignores the URL path; only the JSON body's `op` is dispatched.
const LEASE_RPC_URL = "https://concurrency-lease.internal/rpc";

export class ConcurrencyLeaseClient {
  constructor(private readonly namespace: DurableObjectNamespaceLike) {}

  private async call<T>(
    poolId: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const stub = this.namespace.get(this.namespace.idFromName(poolId));
    const response = await stub.fetch(LEASE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json()) as T;
  }

  acquire(input: {
    poolId: string;
    leaseKey: string;
    cap: number;
    ttlMs: number;
    meta?: Record<string, string>;
  }): Promise<AcquireResult> {
    return this.call<AcquireResult>(input.poolId, {
      op: "acquire",
      leaseKey: input.leaseKey,
      cap: input.cap,
      ttlMs: input.ttlMs,
      meta: input.meta,
    });
  }

  renew(input: {
    poolId: string;
    leaseKey: string;
    ttlMs: number;
    leaseId?: string;
  }): Promise<RenewResult> {
    return this.call<RenewResult>(input.poolId, {
      op: "renew",
      leaseKey: input.leaseKey,
      ttlMs: input.ttlMs,
      leaseId: input.leaseId,
    });
  }

  release(input: {
    poolId: string;
    leaseKey: string;
    leaseId?: string;
  }): Promise<ReleaseResult> {
    return this.call<ReleaseResult>(input.poolId, {
      op: "release",
      leaseKey: input.leaseKey,
      leaseId: input.leaseId,
    });
  }

  currentActiveCount(input: { poolId: string }): Promise<CountResult> {
    return this.call<CountResult>(input.poolId, { op: "count" });
  }
}
