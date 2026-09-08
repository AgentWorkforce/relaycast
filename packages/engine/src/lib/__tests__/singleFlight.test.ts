import { describe, expect, it, vi } from 'vitest';
import { trailingSingleFlight } from '../singleFlight.js';

describe('trailing single flight', () => {
  it('admits a new trigger in the completion microtask without stale cleanup deleting it', async () => {
    const flights = new Map<string, { dirty: boolean; promise: Promise<number> }>();
    let finishFirst!: (n: number) => void;
    let finishSecond!: (n: number) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<number>(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<number>(resolve => { finishSecond = resolve; }));
    const first = trailingSingleFlight(flights, 'node', run);
    await Promise.resolve(); // first run is awaiting its source promise
    let second!: Promise<number>;
    finishFirst(1);
    // Queued after run's resolution, BEFORE any external promise .finally.
    await new Promise<void>(resolve => queueMicrotask(() => {
      second = trailingSingleFlight(flights, 'node', run);
      resolve();
    }));
    expect(second).not.toBe(first);
    expect(await first).toBe(1);
    expect(flights.get('node')?.promise).toBe(second);
    finishSecond(2);
    expect(await second).toBe(2);
    expect(flights.size).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cleans up a rejected flight so a later trigger can recover', async () => {
    const flights = new Map<string, { dirty: boolean; promise: Promise<number> }>();
    await expect(trailingSingleFlight(flights, 'node', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(flights.size).toBe(0);
    expect(await trailingSingleFlight(flights, 'node', async () => 1)).toBe(1);
  });
});
