import { expect, it, vi } from 'vitest';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../../db/schema.js';
import { deliverEvent } from '../../engine/eventDelivery.js';
import { createWorkspace, makeNodeStack } from './harness.js';

it('delivers newly initialized webhooks when database work crosses a clock tick', async () => {
  const stack = makeNodeStack();
  const workspace = await createWorkspace(stack.app, 'webhook-clock-tick');
  await stack.settle();
  const db = stack.runtime.deps.db;
  await db.insert(eventSubscriptions).values({
    id: 'sub_clock_tick',
    workspaceId: workspace.workspaceId,
    events: ['message.created'],
    url: 'https://example.com/hook',
  });
  await db.insert(pendingEvents).values({
    id: 'evt_clock_tick',
    workspaceId: workspace.workspaceId,
    eventType: 'message.created',
    payload: { text: 'send immediately' },
  });

  // Model the clock captured at call entry falling in the previous second
  // from SQLite's insert-time unixepoch(). No sleep or timing race is needed.
  const now = new Date(Date.now() - 1_000);
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  const deliver = () => deliverEvent(
    db, workspace.workspaceId, 'message.created', { text: 'send immediately' },
    { eventId: 'evt_clock_tick', now, fetch },
  );
  await expect(deliver()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [delivery] = await db.select().from(webhookDeliveries);
  expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1 });

  await expect(deliver()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
