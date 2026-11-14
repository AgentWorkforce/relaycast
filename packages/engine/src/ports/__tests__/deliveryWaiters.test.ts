import { describe, expect, it } from 'vitest';
import { DELIVERY_NOTIFY_MEMORY_MS, InProcessDeliveryWaiters } from '../deliveryWaiters.js';

describe('InProcessDeliveryWaiters', () => {
  it('wakes every waiter for the notified agent only', async () => {
    const waiters = new InProcessDeliveryWaiters();
    const since = Date.now();
    const a1 = waiters.wait({ workspaceId: 'w', agentId: 'a', since, timeoutMs: 5_000 });
    const a2 = waiters.wait({ workspaceId: 'w', agentId: 'a', since, timeoutMs: 5_000 });
    const b = waiters.wait({ workspaceId: 'w', agentId: 'b', since, timeoutMs: 30 });
    const otherWorkspace = waiters.wait({ workspaceId: 'x', agentId: 'a', since, timeoutMs: 30 });
    await waiters.notify('w', ['a', 'a']);
    expect(await Promise.all([a1, a2, b, otherWorkspace])).toEqual(['notified', 'notified', 'timeout', 'timeout']);
  });

  it('resolves a registration whose read started before a notify that already landed', async () => {
    let now = 1_000;
    const waiters = new InProcessDeliveryWaiters(() => now);
    await waiters.notify('w', ['a']);
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 900, timeoutMs: 5_000 })).toBe('notified');
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 1_001, timeoutMs: 10 })).toBe('timeout');

    now += DELIVERY_NOTIFY_MEMORY_MS + 1;
    await waiters.notify('w', ['b']);
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 0, timeoutMs: 10 })).toBe('timeout');
  });

  it('answers an aborted or zero-length wait with timeout even after a recent notify', async () => {
    const waiters = new InProcessDeliveryWaiters();
    await waiters.notify('w', ['a']);
    const aborted = new AbortController();
    aborted.abort();
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 0, timeoutMs: 5_000, signal: aborted.signal })).toBe('timeout');
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 0, timeoutMs: 0 })).toBe('timeout');
  });

  it('keeps a re-notified agent when older entries expire', async () => {
    let now = 0;
    const waiters = new InProcessDeliveryWaiters(() => now);
    await waiters.notify('w', ['a', 'b']);
    now = DELIVERY_NOTIFY_MEMORY_MS;
    await waiters.notify('w', ['a']);
    now = DELIVERY_NOTIFY_MEMORY_MS + 1;
    await waiters.notify('w', ['c']);
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: 1, timeoutMs: 10 })).toBe('notified');
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'b', since: 0, timeoutMs: 10 })).toBe('timeout');
  });

  it('answers parked and later waits on close', async () => {
    const waiters = new InProcessDeliveryWaiters();
    const parked = waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 60_000 });
    waiters.close();
    expect(await parked).toBe('timeout');
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 60_000 })).toBe('timeout');
  });

  it('times out and aborts', async () => {
    const waiters = new InProcessDeliveryWaiters();
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 10 })).toBe('timeout');
    const controller = new AbortController();
    const parked = waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await parked).toBe('timeout');
  });
});

describe('InProcessDeliveryWaiters delivery-state waits (send wait_ms)', () => {
  it('wakes a send parked on any of its rows, and only for those rows', async () => {
    const waiters = new InProcessDeliveryWaiters();
    const since = Date.now();
    const parked = waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1', 'd2'], since, timeoutMs: 5_000 });
    const other = waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d9'], since, timeoutMs: 30 });
    const otherWorkspace = waiters.waitForDeliveryState({ workspaceId: 'x', deliveryIds: ['d1'], since, timeoutMs: 30 });
    await waiters.notifyDeliveryState('w', ['d2']);
    expect(await Promise.all([parked, other, otherWorkspace])).toEqual(['notified', 'timeout', 'timeout']);
  });

  it('resolves a registration whose read started before the row moved, and keeps agent waits apart', async () => {
    let now = 1_000;
    const waiters = new InProcessDeliveryWaiters(() => now);
    await waiters.notifyDeliveryState('w', ['d1']);
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 900, timeoutMs: 5_000 })).toBe('notified');
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 1_001, timeoutMs: 10 })).toBe('timeout');
    // A delivery id never wakes an agent long-poll, nor the reverse.
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'd1', since: 0, timeoutMs: 10 })).toBe('timeout');
    await waiters.notify('w', ['d2']);
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d2'], since: 0, timeoutMs: 10 })).toBe('timeout');
    now += DELIVERY_NOTIFY_MEMORY_MS + 1;
    await waiters.notifyDeliveryState('w', ['d3']);
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 0, timeoutMs: 10 })).toBe('timeout');
  });

  it('answers an empty, aborted or zero-length state wait with timeout, and every parked one on close', async () => {
    const waiters = new InProcessDeliveryWaiters();
    const aborted = new AbortController();
    aborted.abort();
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 0, timeoutMs: 5_000, signal: aborted.signal })).toBe('timeout');
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 0, timeoutMs: 0 })).toBe('timeout');
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: [], since: 0, timeoutMs: 5_000 })).toBe('timeout');
    const parked = waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: Date.now(), timeoutMs: 5_000 });
    waiters.close();
    expect(await parked).toBe('timeout');
    expect(await waiters.waitForDeliveryState({ workspaceId: 'w', deliveryIds: ['d1'], since: 0, timeoutMs: 5_000 })).toBe('timeout');
  });
});
