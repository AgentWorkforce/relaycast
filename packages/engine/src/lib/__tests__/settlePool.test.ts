import { describe, expect, it, vi } from 'vitest';
import { settlePool } from '../settlePool.js';

describe('rolling all-settled pool', () => {
  it('uses free slots without waiting for the slowest task, including after failure', async () => {
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const reject: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, n) => async () => {
      started.push(n); active++; peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve, fail) => {
          finish[n] = resolve; reject[n] = () => fail(new Error('dispatch failed'));
        });
      } finally { active--; }
    });
    const result = settlePool(tasks, 4);
    expect(started).toEqual([0, 1, 2, 3]);
    finish[1]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    reject[2]!();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]));
    for (const n of [0, 3, 4, 5]) finish[n]!();
    await result;
    expect(peak).toBe(4);
    expect(active).toBe(0);
  });

  it('settles an empty list and synchronous task throws', async () => {
    await settlePool([], 4);
    const next = vi.fn().mockResolvedValue(undefined);
    await settlePool([() => { throw new Error('sync'); }, next], 1);
    expect(next).toHaveBeenCalledOnce();
  });
});
