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

/**
 * A send parked on its own delivery rows (`wait_ms` on `POST /v1/dm` and
 * `POST /v1/channels/:name/messages`). The route reads the rows' state itself
 * (never while parked); the waiter only tells it a row moved.
 */
export interface DeliveryStateWaitArgs {
  workspaceId: string;
  /** The rows still short of the state the caller wants. */
  deliveryIds: readonly string[];
  /**
   * Epoch ms the caller's state read started. A notify for any of these rows
   * at or after `since` resolves the wait at once, closing the gap between the
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
  /**
   * Park until one of `deliveryIds` is notified (any transition: accepted,
   * acked, replied, failed, host-delivered) or `timeoutMs` passes. The caller
   * re-reads the rows and parks again if they are still short of its target.
   * Hosts that cannot park a request (the workspace actor) leave this out and
   * the send answers at once.
   */
  waitForDeliveryState?(args: DeliveryStateWaitArgs): Promise<'notified' | 'timeout'>;
  /** Wake sends parked on any of `deliveryIds`. Best effort, like {@link notify}. */
  notifyDeliveryState?(workspaceId: string, deliveryIds: readonly string[]): Promise<void>;
}

/** Longest `wait` the route accepts, below common 30 s client and proxy timeouts. */
export const MAX_DELIVERY_WAIT_MS = 25_000;

/** Longest `wait_ms` a send accepts: a short confirmation budget, not a long-poll. */
export const MAX_SEND_WAIT_MS = 2_000;

/** The `wait_ms` the docs recommend: long enough for a live receiver's acceptance round trip. */
export const RECOMMENDED_SEND_WAIT_MS = 1_000;

/** How long a notify still resolves a registration whose read started before it. */
export const DELIVERY_NOTIFY_MEMORY_MS = 60_000;

type Finish = (outcome: 'notified' | 'timeout') => void;

/**
 * Parked callers keyed by a string, with the recent notify times that answer a
 * registration whose read started before the notify.
 */
class KeyedWaiters {
  private readonly waiters = new Map<string, Set<Finish>>();
  /** Oldest notify first: a key is re-inserted on every notify, so pruning stops at the first live entry. */
  private readonly lastNotified = new Map<string, number>();
  private closed = false;

  constructor(private readonly now: () => number) {}

  wait(keys: readonly string[], since: number, timeoutMs: number, signal?: AbortSignal): Promise<'notified' | 'timeout'> {
    if (this.closed || signal?.aborted || timeoutMs <= 0 || keys.length === 0) return Promise.resolve('timeout');
    if (keys.some((key) => (this.lastNotified.get(key) ?? -Infinity) >= since)) return Promise.resolve('notified');
    return new Promise((resolve) => {
      const sets = keys.map((key) => {
        let set = this.waiters.get(key);
        if (!set) {
          set = new Set();
          this.waiters.set(key, set);
        }
        return [key, set] as const;
      });
      const finish: Finish = (outcome) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        for (const [key, set] of sets) {
          set.delete(finish);
          if (set.size === 0 && this.waiters.get(key) === set) this.waiters.delete(key);
        }
        resolve(outcome);
      };
      const onAbort = () => finish('timeout');
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      for (const [, set] of sets) set.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  notify(keys: Iterable<string>): void {
    const now = this.now();
    for (const [key, at] of this.lastNotified) {
      if (now - at <= DELIVERY_NOTIFY_MEMORY_MS) break;
      this.lastNotified.delete(key);
    }
    for (const key of new Set(keys)) {
      this.lastNotified.delete(key);
      this.lastNotified.set(key, now);
      for (const finish of [...(this.waiters.get(key) ?? [])]) finish('notified');
    }
  }

  close(): void {
    this.closed = true;
    for (const set of [...this.waiters.values()]) {
      for (const finish of [...set]) finish('timeout');
    }
  }
}

/** Waiters and recent notify times held in this process. */
export class InProcessDeliveryWaiters implements DeliveryWaiters {
  private readonly byAgent: KeyedWaiters;
  private readonly byDelivery: KeyedWaiters;

  constructor(now: () => number = Date.now) {
    this.byAgent = new KeyedWaiters(now);
    this.byDelivery = new KeyedWaiters(now);
  }

  wait(args: DeliveryWaitArgs): Promise<'notified' | 'timeout'> {
    return this.byAgent.wait([waiterKey(args.workspaceId, args.agentId)], args.since, args.timeoutMs, args.signal);
  }

  async notify(workspaceId: string, agentIds: readonly string[]): Promise<void> {
    this.byAgent.notify(agentIds.map((agentId) => waiterKey(workspaceId, agentId)));
  }

  waitForDeliveryState(args: DeliveryStateWaitArgs): Promise<'notified' | 'timeout'> {
    return this.byDelivery.wait(
      args.deliveryIds.map((deliveryId) => waiterKey(args.workspaceId, deliveryId)),
      args.since,
      args.timeoutMs,
      args.signal,
    );
  }

  async notifyDeliveryState(workspaceId: string, deliveryIds: readonly string[]): Promise<void> {
    this.byDelivery.notify(deliveryIds.map((deliveryId) => waiterKey(workspaceId, deliveryId)));
  }

  /** Answers every parked wait, and every later one, with `'timeout'` (runtime shutdown). */
  close(): void {
    this.byAgent.close();
    this.byDelivery.close();
  }
}

function waiterKey(workspaceId: string, id: string): string {
  return `${workspaceId}\u0000${id}`;
}
