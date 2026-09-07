import { expect, it, vi } from 'vitest';
import { DurableEventQueue } from '../../adapters/node/event-queue.js';
import { makeNodeStack } from './harness.js';

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
