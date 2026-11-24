import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../../db/tables.js';
import { deliverEvent } from '../../engine/eventDelivery.js';
import { sha256Hex } from '../../lib/crypto.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';
import { configureNodeLiveness, nodeLivenessAuthority } from '../../ports/nodeLiveness.js';
import { inheritCredentials } from '../../auth/credentials.js';
import { createWorkspace, makeNodeStack, stripTransactionCapability, type TestStack } from './harness.js';

/**
 * The first delivery pass of a persistent event reads the outbox row once,
 * alongside the subscriptions, and claims each matching target's stable
 * delivery row straight after initializing it. On D1 every statement is a
 * network round trip, so these are the statements a push waits on before its
 * first POST.
 */

const EVENT = 'evt_first_pass';
const SUB = 'sub_first_pass';
const OTHER = 'sub_first_pass_other';
const LATE = 'sub_first_pass_late';

const label = (sql: string) => sql.replace(/\s+/g, ' ').match(/^(select .*? from "\w+"|update "\w+"|insert into "\w+"|delete from "\w+")/)?.[1]
  .replace(/^select .*? from/, 'select from') ?? sql.slice(0, 40);

/** `stableDeliveryId` of eventDelivery.ts. */
async function deliveryId(eventId: string, subscriptionId: string): Promise<string> {
  return `whd_${(await sha256Hex(`${eventId}\0${subscriptionId}`)).slice(0, 32)}`;
}

type Recorded = { label: string; step: boolean; inner?: string[] };
type Hooks = {
  before?: (statement: string) => Promise<void> | undefined;
  after?: (statement: string) => void;
};

/**
 * Records each statement the handle executes, as the existing settlement test
 * does by wrapping a builder's `then`: a statement starts when it is awaited.
 * A statement that starts while no other is in flight begins a new sequential
 * step; one that starts while another is in flight runs in parallel with it.
 * An atomic write group (`withTransaction`, which `runAtomicWrites` prefers on
 * this backend; a single `batch` round trip on D1) is recorded as one entry
 * listing its statements. Builders run against their own `this`, so drizzle
 * internals never see the wrapper. `hooks.before` may hold a statement back
 * (it starts once the returned promise settles) and `hooks.after` runs when
 * one resolves, to stage an interleaving deterministically.
 */
function instrument(db: EngineDb, hooks: Hooks = {}) {
  const statements: Recorded[] = [];
  let inFlight = 0;
  const builderLike = (value: unknown): value is object => !!value && typeof value === 'object'
    && ['then', 'from', 'values', 'set'].some((key) => typeof (value as Record<string, unknown>)[key] === 'function');
  const wrap = <T extends object>(target: T, group?: string[]): T => new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, obj) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'then') {
        return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
          // A raw statement (PostgreSQL's insert-select) has getQuery, not toSQL.
          const statement = obj as { toSQL?: () => { sql: string }; getQuery?: () => { sql: string } };
          const sql = statement.toSQL?.().sql ?? statement.getQuery?.().sql ?? '?';
          if (group) {
            group.push(label(sql));
            return (value as (f: unknown, r: unknown) => unknown).call(obj, onFulfilled, onRejected);
          }
          const run = () => {
            statements.push({ label: label(sql), step: inFlight === 0 });
            inFlight += 1;
            return (value as (f: unknown, r: unknown) => unknown).call(
              obj,
              (result: unknown) => {
                inFlight -= 1;
                hooks.after?.(label(sql));
                return onFulfilled ? onFulfilled(result) : result;
              },
              (error: unknown) => { inFlight -= 1; if (onRejected) return onRejected(error); throw error; },
            );
          };
          const held = hooks.before?.(label(sql));
          return held ? held.then(run) : run();
        };
      }
      if (prop === 'withTransaction' && !group) {
        return (fn: (tx: EngineDb) => Promise<unknown>) => {
          const entry: Recorded = { label: 'atomic', step: inFlight === 0, inner: [] };
          statements.push(entry);
          inFlight += 1;
          return (value as (f: unknown) => Promise<unknown>)
            .call(obj, (tx: EngineDb) => fn(wrap(tx, entry.inner)))
            .finally(() => { inFlight -= 1; });
        };
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
        if (result === obj) return receiver;
        return builderLike(result) ? wrap(result, group) : result;
      };
    },
  });
  const wrapped = wrap(db);
  // runAtomicWrites copies these handle bindings onto its transaction handle;
  // give the wrapper the real handle's so that copy changes nothing.
  configureNodeLiveness(wrapped, nodeLivenessAuthority(db));
  inheritCredentials(wrapped, db);
  return { db: wrapped, statements };
}

describe('webhook first delivery pass', () => {
  let stack: TestStack;
  let db: EngineDb;
  let workspaceId: string;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000 + 250);

  beforeEach(async () => {
    stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'webhook-first-pass');
    await stack.settle();
    db = stack.runtime.deps.db;
    workspaceId = workspace.workspaceId;
  });
  afterEach(async () => { await stack.close(); });

  async function subscribe(id: string, url: string, filter: Record<string, unknown> | null = null) {
    await db.insert(eventSubscriptions).values({
      id, workspaceId, events: ['message.created'], url, filter,
    });
  }

  async function outbox(eventId = EVENT) {
    await db.insert(pendingEvents).values({
      id: eventId, workspaceId, eventType: 'message.created', payload: { text: 'hi' },
    });
  }

  function okFetch() {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
  }

  function deliver(handle: EngineDb, fetch: typeof globalThis.fetch | undefined, at = now, eventId = EVENT) {
    return deliverEvent(handle, workspaceId, 'message.created', { text: 'hi' }, { eventId, now: at, fetch });
  }

  async function rows() {
    return db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, EVENT));
  }

  it('issues three sequential steps before the first POST', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    await outbox();
    const counted = instrument(db);
    let beforePost: Recorded[] | undefined;
    const fetch = vi.fn(async () => {
      beforePost ??= counted.statements.slice();
      return new Response(null, { status: 200 });
    });

    await deliver(counted.db, fetch);

    expect(fetch).toHaveBeenCalledTimes(1);
    const shape = beforePost!.map((entry) => entry.inner ? `atomic[${entry.inner.join(', ')}]` : entry.label);
    // The outbox read and the subscription read run in parallel.
    expect(shape.slice(0, 2).sort()).toEqual(['select from "event_subscriptions"', 'select from "pending_events"']);
    expect(beforePost![1].step).toBe(false);
    expect(shape.slice(2)).toEqual([
      // One atomic unit, parent first: one D1 batch round trip.
      'atomic[update "pending_events", insert into "webhook_deliveries", update "pending_events"]',
      'update "webhook_deliveries"',
    ]);
    const steps = beforePost!.filter((entry) => entry.step).length;
    expect(steps).toBe(3);
    // Before this change the first pass issued eight statements, each its own
    // step: outbox createdAt read, subscriptions, outbox initialized read,
    // insert, initialized update, expired-final-attempt dead-letter, row read,
    // claim.
    expect(steps).toBeLessThan(8);
  });

  it('delivers once on the first pass and reports the same summary as the full path', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    await outbox();
    const fetch = okFetch();

    const first = await deliver(db, fetch);
    expect(first).toEqual({
      attempted: 1, succeeded: 1, failed: 0, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(row).toMatchObject({ id: await deliveryId(EVENT, SUB), status: 'succeeded', attempts: 1, lastStatus: 200 });

    // A replay of the now-initialized event takes the full path.
    await expect(deliver(db, fetch, new Date(now.getTime() + 1_000))).resolves.toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('delivers once when a crashed pass inserted the row but never marked the event initialized', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    await outbox();
    await db.insert(webhookDeliveries).values({
      id: await deliveryId(EVENT, SUB), eventId: EVENT, subscriptionId: SUB, nextAttemptAt: now,
    });
    const fetch = okFetch();

    await expect(deliver(db, fetch)).resolves.toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    await expect(deliver(db, fetch, new Date(now.getTime() + 1_000))).resolves.toMatchObject({ succeeded: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'succeeded', attempts: 1 });
    const [parent] = await db.select().from(pendingEvents).where(eq(pendingEvents.id, EVENT));
    expect(parent.webhookInitialized).toBe(true);
  });

  it('sends exactly one POST per target when two first passes race', async () => {
    await subscribe(SUB, 'https://example.com/a');
    await subscribe(OTHER, 'https://example.com/b');
    await outbox();
    const fetch = vi.fn(async (_url: string | URL | Request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(null, { status: 200 });
    });

    const outcomes = await Promise.allSettled([deliver(db, fetch), deliver(db, fetch)]);

    const urls = fetch.mock.calls.map(([url]) => String(url)).sort();
    expect(urls).toEqual(['https://example.com/a', 'https://example.com/b']);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // The loser may read the winner's rows before they settle.
        expect(outcome.reason).toMatchObject({ code: 'event_delivery_retryable_failure' });
      }
    }
    const settled = await rows();
    expect(settled.map((row) => [row.subscriptionId, row.status, row.attempts]).sort()).toEqual([
      [SUB, 'succeeded', 1],
      [OTHER, 'succeeded', 1],
    ].sort());
  });

  /**
   * A queue redelivery can run a second first pass that reads the outbox row
   * (still uninitialized) before the winner commits, and the subscriptions
   * only after `meanwhile` has run: the winner committing and a subscription
   * being created. The two reads share no snapshot.
   */
  function passReadingFlagBefore(meanwhile: () => Promise<void>) {
    let flagRead!: () => void;
    const flagReadDone = new Promise<void>((resolve) => { flagRead = resolve; });
    return instrument(db, {
      after: (statement) => { if (statement === 'select from "pending_events"') flagRead(); },
      before: (statement) => statement === 'select from "event_subscriptions"'
        ? flagReadDone.then(meanwhile)
        : undefined,
    }).db;
  }

  it('keeps a subscription created after the winning pass committed out of the event', async () => {
    await subscribe(SUB, 'https://example.com/a');
    await outbox();
    const fetch = okFetch();
    const late = passReadingFlagBefore(async () => {
      await expect(deliver(db, fetch)).resolves.toMatchObject({ attempted: 1, succeeded: 1 });
      await subscribe(LATE, 'https://example.com/late');
    });

    // The late pass inserts nothing and finds the winner's row settled.
    await expect(deliver(late, fetch)).resolves.toEqual({
      attempted: 1, succeeded: 1, failed: 0, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://example.com/a']);
    expect((await rows()).map((row) => [row.subscriptionId, row.status])).toEqual([[SUB, 'succeeded']]);
  });

  it('keeps a late subscription out when the winning pass had no target', async () => {
    await outbox();
    const fetch = okFetch();
    const late = passReadingFlagBefore(async () => {
      // No subscription yet: the winner marks the event initialized, no rows.
      await expect(deliver(db, fetch)).resolves.toMatchObject({ attempted: 0 });
      await subscribe(LATE, 'https://example.com/late');
    });

    await expect(deliver(late, fetch)).resolves.toEqual({
      attempted: 0, succeeded: 0, failed: 0, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('leaves the event uninitialized when a delivery row insert fails on a handle without rollback', async () => {
    await subscribe(SUB, 'https://example.com/a');
    await subscribe(OTHER, 'https://example.com/b');
    await outbox();
    // Neither withTransaction nor batch: the writes run one by one. In
    // PostgreSQL mode this handle is shared by every test, so put the
    // capability back before anything else can run on it.
    const capability = (db as Partial<TransactionCapability>).withTransaction;
    stripTransactionCapability(db);
    const fetch = okFetch();
    // OTHER is deleted after this pass read it, as its first write starts, so
    // inserting OTHER's row fails (foreign key).
    let deleted = false;
    const failing = instrument(db, {
      before: (statement) => {
        if (deleted || statement !== 'update "pending_events"') return undefined;
        deleted = true;
        return db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, OTHER)).then(() => undefined);
      },
    }).db;

    try {
      await expect(deliver(failing, fetch)).rejects.toThrow();
    } finally {
      (db as Partial<TransactionCapability>).withTransaction = capability;
    }
    expect(fetch).not.toHaveBeenCalled();
    const [parent] = await db.select().from(pendingEvents).where(eq(pendingEvents.id, EVENT));
    expect(parent.webhookInitialized).toBe(false);

    // The next pass initializes again and delivers instead of finding the
    // event initialized with rows missing.
    await expect(deliver(db, fetch)).resolves.toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://example.com/a']);
    const [after] = await db.select().from(pendingEvents).where(eq(pendingEvents.id, EVENT));
    expect(after.webhookInitialized).toBe(true);
  });

  it('fails a stale row of a no-longer-matching subscription in the same pass', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    await subscribe(OTHER, 'https://example.com/other', { channel: 'elsewhere' });
    await outbox();
    // A crashed earlier pass snapshotted OTHER when it still matched.
    await db.insert(webhookDeliveries).values({
      id: await deliveryId(EVENT, OTHER), eventId: EVENT, subscriptionId: OTHER, nextAttemptAt: now,
    });
    const fetch = okFetch();

    const expected = {
      attempted: 2, succeeded: 1, failed: 1, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    };
    await expect(deliver(db, fetch)).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('https://example.com/hook');
    const byId = new Map((await rows()).map((row) => [row.subscriptionId, row]));
    expect(byId.get(SUB)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(byId.get(OTHER)).toMatchObject({
      status: 'failed', attempts: 0, lastError: 'subscription inactive or no longer matches this event',
    });

    await expect(deliver(db, fetch, new Date(now.getTime() + 1_000))).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('dead-letters an expired final attempt in the same pass', async () => {
    await subscribe(SUB, 'https://example.com/a');
    await subscribe(OTHER, 'https://example.com/b');
    await outbox();
    // Another consumer used SUB's last attempt and crashed before settling;
    // its lease has expired. The event was never marked initialized.
    await db.insert(webhookDeliveries).values({
      id: await deliveryId(EVENT, SUB), eventId: EVENT, subscriptionId: SUB, attempts: 7,
      nextAttemptAt: new Date(now.getTime() - 1_000),
    });
    const fetch = okFetch();

    const expected = {
      attempted: 2, succeeded: 1, failed: 1, retryableFailures: 0, deadLettered: 1, nextRetryAt: null,
    };
    await expect(deliver(db, fetch)).resolves.toEqual(expected);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://example.com/b']);
    const byId = new Map((await rows()).map((row) => [row.subscriptionId, row]));
    expect(byId.get(SUB)).toMatchObject({
      status: 'dead_letter', attempts: 7, lastError: 'attempts exhausted after delivery lease expired',
    });
    expect(byId.get(OTHER)).toMatchObject({ status: 'succeeded', attempts: 1 });

    await expect(deliver(db, fetch, new Date(now.getTime() + 1_000))).resolves.toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails a crashed pass row as unavailable when no target matches on the first pass', async () => {
    await subscribe(OTHER, 'https://example.com/other', { channel: 'elsewhere' });
    await outbox();
    await db.insert(webhookDeliveries).values({
      id: await deliveryId(EVENT, OTHER), eventId: EVENT, subscriptionId: OTHER, nextAttemptAt: now,
    });
    const fetch = okFetch();

    await expect(deliver(db, fetch)).resolves.toEqual({
      attempted: 1, succeeded: 0, failed: 1, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'failed', lastError: 'subscription inactive or no longer matches this event' });
  });

  it('delivers nothing when the outbox row is gone', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    const fetch = okFetch();

    await expect(deliver(db, fetch)).resolves.toEqual({
      attempted: 0, succeeded: 0, failed: 0, retryableFailures: 0, deadLettered: 0, nextRetryAt: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('refuses to deliver without a safe fetch before claiming anything', async () => {
    await subscribe(SUB, 'https://example.com/hook');
    await outbox();

    await expect(deliver(db, undefined)).rejects.toMatchObject({ code: 'event_delivery_fetch_required' });
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending', attempts: 0 });
  });
});
