import { expect, it } from 'vitest';
import { BackgroundTasks } from './backgroundTasks.js';

it('drains remaining and newly tracked work before reporting failures', async () => {
  const tasks = new BackgroundTasks();
  const failure = new Error('background task failed');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  tasks.track(Promise.reject(failure));
  let nestedFinished = false;
  tasks.track(gate.then(() => {
    tasks.track(Promise.resolve().then(() => { nestedFinished = true; }));
  }));
  let drained = false;
  const draining = tasks.drain().catch((error: unknown) => error).then((error) => {
    drained = true;
    return error;
  });
  try {
    // A microtask checkpoint, not a timing guess: let the rejection propagate.
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expect(drained, 'drain returned while another task was still blocked').toBe(false);
  } finally {
    release();
  }
  const error = await draining;
  expect(nestedFinished).toBe(true);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([failure]);
});

it('reports failures that settled before drain started', async () => {
  const tasks = new BackgroundTasks();
  const failure = new Error('early background failure');
  await tasks.track(Promise.reject(failure)).catch(() => {});
  await expect(tasks.drain()).rejects.toMatchObject({ errors: [failure] });
  await expect(tasks.drain()).resolves.toBeUndefined();
});
