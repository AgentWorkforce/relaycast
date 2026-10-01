import type { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { waitForSignal } from '../../../../scripts/test-support/signals.js';

/** Observe existing completion promises without advancing time or starting work. */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    // Keep the original promise/rejection visible to its caller.
    void promise.then(
      () => this.pending.delete(promise),
      (error: unknown) => {
        this.failures.push(error);
        this.pending.delete(promise);
      },
    );
    return promise;
  }

  async drain(timeoutMs = 10_000): Promise<void> {
    await waitForSignal((async () => {
      while (this.pending.size) {
        await Promise.allSettled([...this.pending]);
      }
    })(), 'background task completion', timeoutMs);
    if (this.failures.length) {
      throw new AggregateError(this.failures.splice(0), 'Background tasks failed');
    }
  }

  /** Hono passes these promises to the same waitUntil port used in production. */
  bind(app: Hono<AppEnv>): void {
    const request = app.request.bind(app);
    app.request = (input, init, env, executionCtx) => request(input, init, env, executionCtx ?? {
      waitUntil: (promise: Promise<unknown>) => { this.track(promise); },
      passThroughOnException() {},
      props: {},
    });
  }
}
