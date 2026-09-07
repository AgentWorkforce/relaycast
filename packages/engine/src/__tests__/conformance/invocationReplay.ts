import { vi } from 'vitest';
import * as retry from '../../engine/invocationRetry.js';
import { waitForSignal } from '../../../../../scripts/test-support/signals.js';

/** Hold the losing request at the actual pending-claim boundary until dispatch commits. */
export async function invokeWithConcurrentReplay(
  invoke: () => Promise<Response>,
  frameSent: Promise<void>,
  resumeSend: () => void,
  timeoutMs = 1_000,
): Promise<[Response, Response]> {
  const wait = <T>(promise: PromiseLike<T>, name: string) => waitForSignal(promise, name, timeoutMs);
  const freshPromise = invoke();
  let replayPromise: Promise<Response> | undefined;
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  let retryEntered!: () => void;
  const retrySignal = new Promise<void>((resolve) => { retryEntered = resolve; });
  const originalRetry = retry.waitForPendingInvocationRetry;
  let retrySpy: ReturnType<typeof vi.spyOn> | undefined;
  let result: [Response, Response] | undefined;
  const failures: unknown[] = [];
  try {
    await wait(Promise.race([
      frameSent,
      freshPromise.then(() => { throw new Error('Fresh invocation answered before provider dispatch'); }),
    ]), 'provider dispatch frame');
    retrySpy = vi.spyOn(retry, 'waitForPendingInvocationRetry').mockImplementation(async () => {
      retryEntered();
      await wait(retryGate, 'pending-claim retry release');
      await originalRetry();
    });
    replayPromise = invoke();
    await wait(Promise.race([
      retrySignal,
      replayPromise.then(() => { throw new Error('Replay answered before dispatch completed'); }),
    ]), 'pending-claim retry entry');
    resumeSend();
    const fresh = await wait(freshPromise, 'fresh invocation completion');
    releaseRetry();
    result = [fresh, await wait(replayPromise, 'replay invocation completion')];
  } catch (error) {
    failures.push(error);
  } finally {
    resumeSend();
    releaseRetry();
    try {
      await wait(Promise.allSettled([freshPromise, ...(replayPromise ? [replayPromise] : [])]),
        'concurrent invocation cleanup');
    } catch (error) {
      failures.push(error);
    } finally {
      retrySpy?.mockRestore();
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Concurrent invocation failed and cleanup did not finish');
  return result!;
}
