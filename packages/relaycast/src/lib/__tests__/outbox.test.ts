import { describe, expect, it, vi } from 'vitest';
import {
  deliverQueueMessage,
  runOutboxSweep,
  OUTBOX_QUEUE_RETRY_HOLDOFF_MS,
  OUTBOX_SWEEP_MIN_PENDING_AGE_MS,
  OUTBOX_SWEEP_LEASE_MS,
  type OutboxApi,
  type OutboxDb,
  type OutboxQueueMessage,
  type SweptOutboxEvent,
} from '../outbox.js';

const db = {} as OutboxDb;

interface FakeRow {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'failed';
  attempts: number;
  maxAttempts: number;
  processAfter: number;
  lastError?: string;
}

/**
 * In-memory `pending_events` store mirroring the engine's claim semantics
 * (pending + due + attempts left; claiming increments attempts and pushes
 * `process_after` out by the lease) so the consumer/sweep interaction tests
 * exercise the real contract deterministically.
 */
class FakeOutboxStore implements OutboxApi {
  rows: FakeRow[] = [];

  insert(row: Partial<FakeRow> & { id: string }): FakeRow {
    const full: FakeRow = {
      workspaceId: 'ws_1',
      eventType: 'message.created',
      payload: {},
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      processAfter: 0, // due immediately, like a fresh insert
      ...row,
    };
    this.rows.push(full);
    return full;
  }

  row(id: string): FakeRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  async completeEvent(_db: OutboxDb, id: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }

  async failEvent(_db: OutboxDb, id: string, error: string): Promise<void> {
    const row = this.row(id);
    if (row && row.status === 'pending') {
      row.status = 'failed';
      row.lastError = error;
    }
  }

  async rescheduleEvent(_db: OutboxDb, id: string, error: string, backoffMs: number): Promise<void> {
    const row = this.row(id);
    if (row && row.status === 'pending') {
      row.processAfter = Date.now() + backoffMs;
      row.lastError = error;
    }
  }

  async sweepPendingEvents(
    _db: OutboxDb,
    opts: { limit?: number; leaseMs?: number; now?: Date } = {},
  ): Promise<SweptOutboxEvent[]> {
    const now = opts.now?.getTime() ?? Date.now();
    const leaseMs = opts.leaseMs ?? 60_000;
    const claimed = this.rows
      .filter((r) => r.status === 'pending' && r.processAfter <= now && r.attempts < r.maxAttempts)
      .slice(0, opts.limit ?? 25);
    return claimed.map((row) => {
      row.attempts += 1;
      row.processAfter = now + leaseMs;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        eventType: row.eventType,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        complete: () => this.completeEvent(_db, row.id),
        fail: (error: string) => this.failEvent(_db, row.id, error),
        reschedule: (error: string, backoffMs: number) => this.rescheduleEvent(_db, row.id, error, backoffMs),
      };
    });
  }

  async cleanupOldEvents(): Promise<number> {
    return 0;
  }
}

class FakeQueue {
  sent: OutboxQueueMessage[] = [];
  failWith: Error | undefined;
  async send(message: OutboxQueueMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }
}

function message(outboxId?: string): OutboxQueueMessage {
  return { type: 'message.created', workspaceId: 'ws_1', data: { text: 'hi' }, outboxId };
}

const okSummary = { attempted: 1, succeeded: 1, failed: 0, retryableFailures: 0 };

describe('deliverQueueMessage settle paths', () => {
  it('success → completeEvent (row deleted), no throw', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1' });
    const deliver = vi.fn(async () => okSummary);

    await deliverQueueMessage(db, message('evt_1'), store, { deliver });

    expect(deliver).toHaveBeenCalledWith(db, 'ws_1', 'message.created', { text: 'hi' });
    expect(store.row('evt_1')).toBeUndefined();
  });

  it('terminal failure (summary.failed > 0) → failEvent, no throw (caller acks)', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1' });
    const deliver = vi.fn(async () => ({ attempted: 2, succeeded: 1, failed: 1, retryableFailures: 0 }));

    await deliverQueueMessage(db, message('evt_1'), store, { deliver });

    const row = store.row('evt_1')!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/terminal delivery failure: 1 of 2/);
  });

  it('retryable failure → rethrows for CF redelivery and holds the row off past the retry horizon', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1' });
    const deliver = vi.fn(async () => { throw new Error('subscriber 503'); });

    const before = Date.now();
    await expect(deliverQueueMessage(db, message('evt_1'), store, { deliver })).rejects.toThrow('subscriber 503');

    const row = store.row('evt_1')!;
    expect(row.status).toBe('pending'); // NOT settled — CF owns the retry
    expect(row.lastError).toBe('subscriber 503');
    expect(row.processAfter).toBeGreaterThanOrEqual(before + OUTBOX_QUEUE_RETRY_HOLDOFF_MS);
  });

  it('legacy message without outboxId never touches the outbox', async () => {
    const store = new FakeOutboxStore();
    const spy = vi.spyOn(store, 'completeEvent');
    await deliverQueueMessage(db, message(undefined), store, { deliver: vi.fn(async () => okSummary) });
    expect(spy).not.toHaveBeenCalled();
  });

  it('settle failure after successful delivery is swallowed and reported (caller still acks)', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1' });
    vi.spyOn(store, 'completeEvent').mockRejectedValueOnce(new Error('d1 hiccup'));
    const onSettleError = vi.fn();

    await deliverQueueMessage(db, message('evt_1'), store, {
      deliver: vi.fn(async () => okSummary),
      onSettleError,
    });

    expect(onSettleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'd1 hiccup' }));
    // Row remains pending — the sweep re-enqueues it later (at-least-once).
    expect(store.row('evt_1')!.status).toBe('pending');
  });

  it('reschedule failure on the retryable path still rethrows the delivery error', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1' });
    vi.spyOn(store, 'rescheduleEvent').mockRejectedValueOnce(new Error('d1 hiccup'));
    const onSettleError = vi.fn();

    await expect(
      deliverQueueMessage(db, message('evt_1'), store, {
        deliver: vi.fn(async () => { throw new Error('subscriber 503'); }),
        onSettleError,
      }),
    ).rejects.toThrow('subscriber 503');
    expect(onSettleError).toHaveBeenCalledTimes(1);
  });
});

describe('runOutboxSweep', () => {
  it('re-enqueues rows due past the age gate with their outboxId, and runs cleanup', async () => {
    const store = new FakeOutboxStore();
    // Lost send: inserted long ago, never settled.
    store.insert({ id: 'evt_lost', processAfter: Date.now() - 10 * 60_000, payload: { text: 'lost' } });
    const cleanup = vi.spyOn(store, 'cleanupOldEvents');
    const queue = new FakeQueue();

    const result = await runOutboxSweep(db, queue, store);

    expect(result).toEqual({ swept: 1, reenqueued: 1, cleaned: 0 });
    expect(queue.sent).toEqual([
      { type: 'message.created', workspaceId: 'ws_1', data: { text: 'lost' }, outboxId: 'evt_lost' },
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('skips fresh rows the queue is still expected to deliver (age gate)', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_fresh', processAfter: Date.now() }); // just inserted by the request path
    const queue = new FakeQueue();

    const result = await runOutboxSweep(db, queue, store);

    expect(result.swept).toBe(0);
    expect(queue.sent).toHaveLength(0);
    expect(store.row('evt_fresh')!.attempts).toBe(0); // not even claimed
  });

  it('does not double-enqueue a row whose CF retry is in flight (consumer held it off)', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_1', processAfter: Date.now() - 10 * 60_000 });

    // Consumer hit a retryable failure: row held off, message left to CF retries.
    await expect(
      deliverQueueMessage(db, message('evt_1'), store, {
        deliver: vi.fn(async () => { throw new Error('503'); }),
      }),
    ).rejects.toThrow();

    const queue = new FakeQueue();
    const result = await runOutboxSweep(db, queue, store);
    expect(result.swept).toBe(0);
    expect(queue.sent).toHaveLength(0);

    // The in-flight CF retry then succeeds — completeEvent works regardless.
    await deliverQueueMessage(db, message('evt_1'), store, { deliver: vi.fn(async () => okSummary) });
    expect(store.row('evt_1')).toBeUndefined();
  });

  it('a swept row is not re-claimed by an overlapping sweep within the lease', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_lost', processAfter: Date.now() - 10 * 60_000 });
    const queue = new FakeQueue();

    const first = await runOutboxSweep(db, queue, store);
    const second = await runOutboxSweep(db, queue, store);

    expect(first.reenqueued).toBe(1);
    expect(second.swept).toBe(0); // lease holds: no double-processing
    expect(queue.sent).toHaveLength(1);
  });

  it('passes the age-gated now and the lease to the engine sweep', async () => {
    const store = new FakeOutboxStore();
    const sweep = vi.spyOn(store, 'sweepPendingEvents');
    const fixed = 1_750_000_000_000;

    await runOutboxSweep(db, new FakeQueue(), store, () => fixed);

    expect(sweep).toHaveBeenCalledWith(db, {
      limit: expect.any(Number),
      leaseMs: OUTBOX_SWEEP_LEASE_MS,
      now: new Date(fixed - OUTBOX_SWEEP_MIN_PENDING_AGE_MS),
    });
  });

  it('a failed queue send leaves the row claimed for a later sweep and does not abort others', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_a', processAfter: Date.now() - 10 * 60_000 });
    store.insert({ id: 'evt_b', processAfter: Date.now() - 10 * 60_000 });
    const queue = new FakeQueue();
    let calls = 0;
    vi.spyOn(queue, 'send').mockImplementation(async (msg: OutboxQueueMessage) => {
      calls += 1;
      if (calls === 1) throw new Error('queue blip');
      queue.sent.push(msg);
    });

    const result = await runOutboxSweep(db, queue, store);

    expect(result.swept).toBe(2);
    expect(result.reenqueued).toBe(1);
    // Both rows remain claimed (pending, lease in the future) — the failed one
    // is re-offered after lease expiry rather than lost.
    expect(store.row('evt_a')!.status).toBe('pending');
    expect(store.row('evt_b')!.status).toBe('pending');
  });

  it('surfaces a total queue outage (nothing re-enqueued) to the caller', async () => {
    const store = new FakeOutboxStore();
    store.insert({ id: 'evt_a', processAfter: Date.now() - 10 * 60_000 });
    const queue = new FakeQueue();
    queue.failWith = new Error('queue down');

    await expect(runOutboxSweep(db, queue, store)).rejects.toThrow('queue down');
  });
});
