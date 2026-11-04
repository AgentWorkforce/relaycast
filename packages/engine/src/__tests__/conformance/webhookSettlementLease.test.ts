import { expect, it, vi } from 'vitest';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../../db/schema.js';
import { deliverEvent } from '../../engine/eventDelivery.js';
import { createWorkspace, makeNodeStack } from './harness.js';

const cases = [200, 400, 503].flatMap(oldStatus => [0, 5].map(initialAttempts => ({ oldStatus, initialAttempts })));

it.each(cases)('fences stale HTTP $oldStatus after $initialAttempts prior attempts', async ({ oldStatus, initialAttempts }) => {
  const start = new Date(Math.floor(Date.now() / 1000) * 1000 + 321);
  const stack = makeNodeStack();
  const workspace = await createWorkspace(stack.app, 'webhook-settlement-lease');
  await stack.settle();
  const db = stack.runtime.deps.db;
  await db.insert(eventSubscriptions).values({
    id: 'sub_stale', workspaceId: workspace.workspaceId,
    events: ['message.created'], url: 'https://example.com/hook',
  });
  await db.insert(pendingEvents).values({
    id: 'evt_stale', workspaceId: workspace.workspaceId, eventType: 'message.created',
    payload: {}, webhookInitialized: initialAttempts > 0,
  });
  if (initialAttempts > 0) {
    await db.insert(webhookDeliveries).values({
      id: 'whd_stale', eventId: 'evt_stale', subscriptionId: 'sub_stale',
      attempts: initialAttempts, nextAttemptAt: start,
    });
  }
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const settlementStarted = new Promise<void>(resolve => { entered = resolve; });
  let holdFirstSettlement = true;
  const originalUpdate = db.update.bind(db);
  const updateSpy = vi.spyOn(db, 'update').mockImplementation(table => {
    const update = originalUpdate(table);
    const originalSet = update.set.bind(update);
    vi.spyOn(update, 'set').mockImplementation(values => {
      const query = originalSet(values);
      if (table === webhookDeliveries && 'lastStatus' in values && holdFirstSettlement) {
        holdFirstSettlement = false;
        // Hold the actual SQL write across a competing claim, modeling a stalled D1 await.
        const originalThen = query.then.bind(query);
        vi.spyOn(query, 'then').mockImplementation((fulfilled, rejected) => blocked.then(() => originalThen(fulfilled, rejected)));
        entered();
      }
      return query;
    });
    return update;
  });
  const later = new Date(start.getTime() + 61_000);
  const send = (now: Date) => deliverEvent(db, workspace.workspaceId, 'message.created', {}, {
    eventId: 'evt_stale', now, fetch: async () => new Response(null, { status: now === start ? oldStatus : 503 }),
  });
  const oldAttempt = send(start).catch(error => error);
  await settlementStarted;
  try {
    if (initialAttempts === 0) {
      await expect(send(later)).rejects.toMatchObject({ code: 'event_delivery_retryable_failure' });
    } else {
      await expect(send(later)).resolves.toMatchObject({ deadLettered: 1 });
    }
    const [before] = await db.select().from(webhookDeliveries);
    expect(before.attempts).toBe(initialAttempts + 2);
    if (initialAttempts === 0) {
      expect(before.nextAttemptAt.getTime()).toBe(Math.floor((later.getTime() + 120_000) / 1000) * 1000);
    } else {
      expect(before.status).toBe('dead_letter');
    }
    release();
    const oldOutcome = await oldAttempt;
    if (initialAttempts === 0) {
      expect(oldOutcome).toMatchObject({ code: 'event_delivery_retryable_failure' });
    } else {
      expect(oldOutcome).toMatchObject({ deadLettered: 1 });
    }
    const [after] = await db.select().from(webhookDeliveries);
    expect(after).toEqual(before);
  } finally {
    release();
    await oldAttempt;
    updateSpy.mockRestore();
  }
});
