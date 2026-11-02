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

  it('times out and aborts', async () => {
    const waiters = new InProcessDeliveryWaiters();
    expect(await waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 10 })).toBe('timeout');
    const controller = new AbortController();
    const parked = waiters.wait({ workspaceId: 'w', agentId: 'a', since: Date.now(), timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await parked).toBe('timeout');
  });
});
