import { describe, expect, it, vi } from 'vitest';
import type { EngineDeps } from '../../../ports/index.js';
import { createDeliveryMaintenanceRunner } from '../delivery-maintenance.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Node delivery maintenance', () => {
  it('serializes HTTP push and expiry and coalesces overlapping cycles', async () => {
    const pushFinished = deferred();
    const order: string[] = [];
    const sweepHttpPush = vi.fn(async () => {
      order.push('push:start');
      await pushFinished.promise;
      order.push('push:end');
    });
    const sweepExpiry = vi.fn(async () => {
      order.push('expiry');
    });
    const deps = {
      telemetry: { captureException: vi.fn() },
    } as unknown as EngineDeps;
    const run = createDeliveryMaintenanceRunner(deps, { sweepHttpPush, sweepExpiry });

    const first = run();
    const overlapping = run();

    expect(overlapping).toBe(first);
    expect(sweepHttpPush).toHaveBeenCalledTimes(1);
    expect(sweepExpiry).not.toHaveBeenCalled();

    pushFinished.resolve();
    await first;

    expect(order).toEqual(['push:start', 'push:end', 'expiry']);
    expect(sweepExpiry).toHaveBeenCalledTimes(1);

    await run();
    expect(sweepHttpPush).toHaveBeenCalledTimes(2);
    expect(sweepExpiry).toHaveBeenCalledTimes(2);
  });

  it('still runs expiry when the HTTP push sweep fails', async () => {
    const error = new Error('push sweep failed');
    const captureException = vi.fn();
    const sweepExpiry = vi.fn(async () => {});
    const deps = {
      telemetry: { captureException },
    } as unknown as EngineDeps;
    const run = createDeliveryMaintenanceRunner(deps, {
      sweepHttpPush: vi.fn(async () => { throw error; }),
      sweepExpiry,
    });

    await expect(run()).resolves.toBeUndefined();

    expect(sweepExpiry).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(error, {
      source: 'node.maintenance',
      op: 'http_push_delivery',
    });
  });
});
