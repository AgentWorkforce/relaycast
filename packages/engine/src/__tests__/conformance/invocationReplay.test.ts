import { afterEach, expect, it, vi } from 'vitest';
import * as retry from '../../engine/invocationRetry.js';
import { invokeWithConcurrentReplay } from './invocationReplay.js';
import { waitForSignal } from '../../../../../scripts/test-support/signals.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('does not mistake an unrelated 10ms timer for a pending-claim retry', async () => {
  let release!: () => void;
  const response = new Promise<Response>((resolve) => { release = () => resolve(new Response()); });
  let calls = 0;
  let unrelatedTimerFired = false;
  const invoke = () => {
    if (++calls === 2) globalThis.setTimeout(() => { unrelatedTimerFired = true; }, 10);
    return response;
  };
  await expect(invokeWithConcurrentReplay(invoke, Promise.resolve(), release, 50))
    .rejects.toThrow('pending-claim retry entry never arrived within 50ms');
  expect(unrelatedTimerFired).toBe(true);
});

it('bounds cleanup when dispatch fails before a replay settles', async () => {
  const originalRetry = retry.waitForPendingInvocationRetry;
  let rejectFresh!: (error: Error) => void;
  const fresh = new Promise<Response>((_, reject) => { rejectFresh = reject; });
  let releaseReplay!: () => void;
  const replay = new Promise<Response>((resolve) => { releaseReplay = () => resolve(new Response()); });
  let retrying: Promise<void> | undefined;
  let calls = 0;
  const invoke = () => {
    if (++calls === 1) return fresh;
    retrying = retry.waitForPendingInvocationRetry();
    return replay;
  };
  const failure = new Error('dispatch failed before replay settled');
  try {
    const error = await invokeWithConcurrentReplay(invoke, Promise.resolve(), () => rejectFresh(failure), 50)
      .catch((error: AggregateError) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      failure.message,
      'concurrent invocation cleanup never arrived within 50ms',
    ]);
    expect(retry.waitForPendingInvocationRetry).toBe(originalRetry);
  } finally {
    releaseReplay();
    if (retrying) await waitForSignal(retrying, 'released retry completion');
  }
});

it('fails with a named bound even while Date and global timers are frozen', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  await expect(waitForSignal(new Promise<void>(() => {}), 'missing frozen-clock signal', 10))
    .rejects.toThrow('missing frozen-clock signal never arrived within 10ms');
  expect(Date.now()).toBe(now);
});

it('names a missing provider frame and still releases the request', async () => {
  let release!: () => void;
  const response = new Promise<Response>((resolve) => { release = () => resolve(new Response()); });
  await expect(invokeWithConcurrentReplay(() => response, new Promise(() => {}), release, 10))
    .rejects.toThrow('provider dispatch frame never arrived within 10ms');
});
