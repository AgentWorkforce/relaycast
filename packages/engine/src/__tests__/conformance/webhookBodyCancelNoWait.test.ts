import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../../db/tables.js';
import { deliverEvent } from '../../engine/eventDelivery.js';
import { createWorkspace, makeNodeStack } from './harness.js';

type CancelBehavior = () => Promise<void>;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
});

async function setup(status: number, cancelBehavior: CancelBehavior) {
  const stack = makeNodeStack();
  const workspace = await createWorkspace(stack.app, 'webhook-body-cancel');
  await stack.settle();
  const db = stack.runtime.deps.db;
  await db.insert(eventSubscriptions).values({
    id: 'sub_cancel', workspaceId: workspace.workspaceId,
    events: ['message.created'], url: 'https://example.com/hook',
  });
  await db.insert(pendingEvents).values({
    id: 'evt_cancel', workspaceId: workspace.workspaceId, eventType: 'message.created', payload: {},
  });
  const cancel = vi.fn(cancelBehavior);
  const fetch = vi.fn(async () => {
    const response = new Response('open', { status });
    Object.defineProperty(response, 'body', { value: { cancel } });
    return response;
  });
  const deliver = () => deliverEvent(db, workspace.workspaceId, 'message.created', {}, {
    eventId: 'evt_cancel', now: new Date(), fetch,
  });
  return { db, cancel, fetch, deliver };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

// Bound only the delivery call: setup time (slower on the PostgreSQL run) must
// not count against it. A delivery that waits on the body never settles here.
const DELIVER_BOUND_MS = 2_000;
function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`deliverEvent still pending after ${DELIVER_BOUND_MS} ms`)),
      DELIVER_BOUND_MS,
    );
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

it('does not wait for a never-settling body cancel on success', async () => {
  const { db, cancel, deliver } = await setup(200, () => new Promise<void>(() => {}));
  await expect(within(deliver())).resolves.toMatchObject({ succeeded: 1, failed: 0 });
  expect(cancel).toHaveBeenCalledTimes(1);
  const [delivery] = await db.select().from(webhookDeliveries);
  expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1 });
});

it('counts success and raises no unhandled rejection when cancel rejects', async () => {
  const { db, cancel, deliver } = await setup(200, () => Promise.reject(new Error('cancel failed')));
  await expect(within(deliver())).resolves.toMatchObject({ succeeded: 1, failed: 0 });
  await flush();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(unhandled).toEqual([]);
  const [delivery] = await db.select().from(webhookDeliveries);
  expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1 });
});

it('counts success and raises no unhandled rejection when cancel throws synchronously', async () => {
  const { db, cancel, deliver } = await setup(200, () => { throw new Error('locked'); });
  await expect(within(deliver())).resolves.toMatchObject({ succeeded: 1, failed: 0 });
  await flush();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(unhandled).toEqual([]);
  const [delivery] = await db.select().from(webhookDeliveries);
  expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1 });
});

it('still classifies a 500 as retryable with a never-settling body cancel', async () => {
  const { cancel, deliver } = await setup(500, () => new Promise<void>(() => {}));
  await expect(within(deliver())).rejects.toMatchObject({ code: 'event_delivery_retryable_failure' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
