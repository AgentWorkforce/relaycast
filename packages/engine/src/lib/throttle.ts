import type { Context } from 'hono';

/** Fixed window used by the per-minute rate limiter. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Index of the fixed window containing `now` — the minute bucket in a bucket key. */
export function rateLimitWindow(now: number): number {
  return Math.floor(now / RATE_LIMIT_WINDOW_MS);
}

/** Unix ms at which the fixed window containing `now` rolls over. */
export function rateLimitWindowResetAt(now: number): number {
  return (rateLimitWindow(now) + 1) * RATE_LIMIT_WINDOW_MS;
}

/**
 * Whole seconds to wait before retrying. Floored at 1: a `Retry-After: 0`
 * invites an immediate retry that is certain to be throttled again.
 */
export function retryAfterSeconds(resetAtMs: number, now: number = Date.now()): number {
  return Math.max(1, Math.ceil((resetAtMs - now) / 1000));
}

/**
 * Attach the retry contract to a 429. Without it a caller can only guess a
 * backoff, and — worse — cannot distinguish a per-minute throttle that clears
 * in seconds from an exhausted plan quota that no bounded retry will outlast,
 * so it burns its whole retry budget on a condition retrying cannot fix.
 */
export function setRetryContract(c: Context, resetAtMs: number, now: number = Date.now()): void {
  c.header('Retry-After', String(retryAfterSeconds(resetAtMs, now)));
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAtMs / 1000)));
}
