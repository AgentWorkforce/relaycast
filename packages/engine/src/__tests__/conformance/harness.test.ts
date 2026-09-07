import { expect, it, vi } from 'vitest';
import { DurableEventQueue } from '../../adapters/node/event-queue.js';
import { makeNodeStack } from './harness.js';

it('closes SQLite even when tracked startup work rejects', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startup = vi.spyOn(DurableEventQueue.prototype, 'poll').mockImplementation(async () => {
    await gate;
    throw new Error('startup poll failed');
  });
  const stack = makeNodeStack();
  try {
    const closing = stack.close();
    release();
    await expect(closing).rejects.toThrow();
    expect(stack.runtime.handle.sqlite.open, 'SQLite remained open after a failed drain').toBe(false);
  } finally {
    release();
    startup.mockRestore();
    stack.runtime.close();
  }
});

it('waits for the startup poll completion before closing SQLite', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const poll = DurableEventQueue.prototype.poll;
  const startup = vi.spyOn(DurableEventQueue.prototype, 'poll').mockImplementation(async function () {
    await gate;
    await poll.call(this);
  });
  const stack = makeNodeStack();
  const closing = stack.close();
  try {
    expect(startup).toHaveBeenCalledTimes(1);
    expect(stack.runtime.handle.sqlite.open).toBe(true);
  } finally {
    release();
    await closing;
    startup.mockRestore();
  }
  expect(stack.runtime.handle.sqlite.open).toBe(false);
});
