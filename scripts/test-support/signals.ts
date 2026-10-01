import { clearTimeout, setTimeout } from 'node:timers';

/** Real-time failure bound, including when a test freezes Date or global timers. */
export async function waitForSignal<T>(
  promise: PromiseLike<T>,
  name: string,
  timeoutMs = 1_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} never arrived within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
