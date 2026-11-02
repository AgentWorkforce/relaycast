/**
 * Long-poll coordination for `GET /v1/deliveries?wait=`.
 *
 * A request whose agent has no active deliveries parks in {@link wait}; every
 * delivery creation calls {@link notify} with its recipients (the same routing
 * call that pushes `deliver` frames to node sockets). Only creation needs a
 * signal: ack, fail, expiry and dead-lettering only shrink the active queue.
 *
 *  - In-process (self-host Node runtime, per-workspace actor): every request
 *    for a workspace runs in one process; {@link InProcessDeliveryWaiters}.
 *  - Cloudflare (cloud repo): the workspace's Durable Object holds the waiters,
 *    so a notify from any isolate wakes a request parked in any other.
 */
export interface DeliveryWaitArgs {
  workspaceId: string;
  agentId: string;
  /**
   * Epoch ms the caller's empty queue read started. A notify for this agent at
   * or after `since` resolves the wait at once, closing the gap between the
   * read and the registration.
   */
  since: number;
  timeoutMs: number;
  /** Aborts the wait (client disconnected); resolves `'timeout'`. */
  signal?: AbortSignal;
}

export interface DeliveryWaiters {
  wait(args: DeliveryWaitArgs): Promise<'notified' | 'timeout'>;
  /** Best effort; a lost notify costs a parked caller latency up to its wait, never a delivery. */
  notify(workspaceId: string, agentIds: readonly string[]): Promise<void>;
}

/** Longest `wait` the route accepts, below common 30 s client and proxy timeouts. */
export const MAX_DELIVERY_WAIT_MS = 25_000;

/** How long a notify still resolves a registration whose read started before it. */
export const DELIVERY_NOTIFY_MEMORY_MS = 60_000;

/** Waiters and recent notify times held in this process. */
export class InProcessDeliveryWaiters implements DeliveryWaiters {
  private readonly waiters = new Map<string, Set<(outcome: 'notified' | 'timeout') => void>>();
  /** Oldest notify first: a key is re-inserted on every notify, so pruning stops at the first live entry. */
  private readonly lastNotified = new Map<string, number>();
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  wait(args: DeliveryWaitArgs): Promise<'notified' | 'timeout'> {
    if (this.closed || args.signal?.aborted || args.timeoutMs <= 0) return Promise.resolve('timeout');
    const key = waiterKey(args.workspaceId, args.agentId);
    if ((this.lastNotified.get(key) ?? -Infinity) >= args.since) return Promise.resolve('notified');
    return new Promise((resolve) => {
      let set = this.waiters.get(key);
      if (!set) {
        set = new Set();
        this.waiters.set(key, set);
      }
      const finish = (outcome: 'notified' | 'timeout') => {
        clearTimeout(timer);
        args.signal?.removeEventListener('abort', onAbort);
        set.delete(finish);
        if (set.size === 0 && this.waiters.get(key) === set) this.waiters.delete(key);
        resolve(outcome);
      };
      const onAbort = () => finish('timeout');
      const timer = setTimeout(() => finish('timeout'), args.timeoutMs);
      set.add(finish);
      args.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async notify(workspaceId: string, agentIds: readonly string[]): Promise<void> {
    const now = this.now();
    for (const [key, at] of this.lastNotified) {
      if (now - at <= DELIVERY_NOTIFY_MEMORY_MS) break;
      this.lastNotified.delete(key);
    }
    for (const agentId of new Set(agentIds)) {
      const key = waiterKey(workspaceId, agentId);
      this.lastNotified.delete(key);
      this.lastNotified.set(key, now);
      for (const finish of [...(this.waiters.get(key) ?? [])]) finish('notified');
    }
  }

  /** Answers every parked wait, and every later one, with `'timeout'` (runtime shutdown). */
  close(): void {
    this.closed = true;
    for (const set of [...this.waiters.values()]) {
      for (const finish of [...set]) finish('timeout');
    }
  }
}

function waiterKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`;
}
