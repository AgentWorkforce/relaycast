import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wiring test for the outbox-aware entrypoints: the queue consumer settles
// `pending_events` rows after delivery and the scheduled handler sweeps due
// rows back onto WEBHOOK_QUEUE. (cloudflare.test.ts covers telemetry-flush
// wiring on the same handlers, with legacy messages that carry no outboxId.)

const flushCloudflareTelemetry = vi.fn().mockResolvedValue(undefined);
const captureException = vi.fn();

const deliverEvent = vi.fn();
const runA2aHealthChecks = vi.fn().mockResolvedValue(undefined);
const completeEvent = vi.fn().mockResolvedValue(undefined);
const failEvent = vi.fn().mockResolvedValue(undefined);
const rescheduleEvent = vi.fn().mockResolvedValue(undefined);
const sweepPendingEvents = vi.fn().mockResolvedValue([]);
const cleanupOldEvents = vi.fn().mockResolvedValue(0);

vi.mock('../../providers/telemetry.js', () => ({
  createCloudflareTelemetry: vi.fn(() => ({ capture: vi.fn(), captureException })),
  flushCloudflareTelemetry,
}));

vi.mock('@relaycast/engine', () => ({
  createEngine: vi.fn(() => ({ fetch: vi.fn(() => new Response('ok')) })),
  deliverEvent,
  runA2aHealthChecks,
  schema: {},
  completeEvent,
  failEvent,
  rescheduleEvent,
  sweepPendingEvents,
  cleanupOldEvents,
}));

vi.mock('../../adapters/cloudflare/index.js', () => ({
  createCloudflareEngineDeps: vi.fn(() => ({})),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({})),
}));

function createCtx(): ExecutionContext & { settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(Promise.resolve(p));
    },
    passThroughOnException: () => {},
    props: {},
    settled: () => Promise.all(pending).then(() => undefined),
  } as ExecutionContext & { settled: () => Promise<void> };
}

const queueSend = vi.fn().mockResolvedValue(undefined);
const env = { DB: {}, POSTHOG_API_KEY: 'phc_test', WEBHOOK_QUEUE: { send: queueSend } } as never;

describe('cloudflare entrypoints with the outbox-capable engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverEvent.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, retryableFailures: 0 });
    sweepPendingEvents.mockResolvedValue([]);
  });

  it('queue consumer completes the outbox row after successful delivery, then acks', async () => {
    const handler = (await import('../cloudflare.js')).default;
    const ack = vi.fn();
    const batch = {
      messages: [
        { body: { type: 'message.created', workspaceId: 'ws_1', data: {}, outboxId: 'evt_1' }, ack, retry: vi.fn() },
      ],
    } as unknown as MessageBatch;

    await handler.queue(batch, env, createCtx());

    expect(completeEvent).toHaveBeenCalledWith(expect.anything(), 'evt_1');
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('queue consumer holds the row off and retries on retryable failure', async () => {
    deliverEvent.mockRejectedValueOnce(new Error('subscriber 503'));
    const handler = (await import('../cloudflare.js')).default;
    const retry = vi.fn();
    const batch = {
      messages: [
        { body: { type: 'message.created', workspaceId: 'ws_1', data: {}, outboxId: 'evt_1' }, ack: vi.fn(), retry },
      ],
    } as unknown as MessageBatch;

    await handler.queue(batch, env, createCtx());

    expect(rescheduleEvent).toHaveBeenCalledWith(expect.anything(), 'evt_1', 'subscriber 503', expect.any(Number));
    expect(completeEvent).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('scheduled handler sweeps due rows back onto the queue and prunes settled ones', async () => {
    sweepPendingEvents.mockResolvedValueOnce([
      {
        id: 'evt_lost',
        workspaceId: 'ws_1',
        eventType: 'message.created',
        payload: { text: 'lost' },
        attempts: 1,
        maxAttempts: 5,
        complete: vi.fn(),
        fail: vi.fn(),
        reschedule: vi.fn(),
      },
    ]);
    const handler = (await import('../cloudflare.js')).default;
    const ctx = createCtx();

    await handler.scheduled({} as ScheduledController, env, ctx);
    await ctx.settled();

    expect(runA2aHealthChecks).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith({
      type: 'message.created',
      workspaceId: 'ws_1',
      data: { text: 'lost' },
      outboxId: 'evt_lost',
    });
    expect(cleanupOldEvents).toHaveBeenCalledTimes(1);
  });
});
