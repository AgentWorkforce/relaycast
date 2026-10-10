import { eq, isNull, type SQL } from 'drizzle-orm';
import { actionInvocations } from '../db/schema.js';

/** Status a pre-send claim observed on the invocation row. */
export type InvocationClaimStatus = 'pending' | 'dispatched';

/**
 * `retry_after_at` is stored as unix seconds. Two deadlines in the same
 * second, and two unset deadlines, are the same compare-and-swap token.
 */
export function sameStoredRetryDeadline(left: Date | null, right: Date | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.floor(left.getTime() / 1000) === Math.floor(right.getTime() / 1000);
}

/**
 * Values an exclusive claim writes.
 *
 * The compare-and-swap pins the observed status, deadline, and
 * `dispatch_attempts`. When the attempt count or the status changes, the
 * requested deadline is kept, including an unset one, so a queued spawn stays
 * due for drain and out of the pending sweep. Only a claim that would
 * otherwise leave all three tokens untouched moves the deadline forward one
 * second.
 */
export function exclusiveClaimWrite(args: {
  observedStatus: InvocationClaimStatus;
  observedRetryAfterAt: Date | null;
  observedDispatchAttempts: number;
  nextStatus: InvocationClaimStatus;
  nextRetryAfterAt: Date | null;
  incrementAttempts: boolean;
}): { retryAfterAt: Date | null; dispatchAttempts: number } {
  const dispatchAttempts = args.incrementAttempts
    ? args.observedDispatchAttempts + 1
    : args.observedDispatchAttempts;
  const moves = args.nextStatus !== args.observedStatus || dispatchAttempts !== args.observedDispatchAttempts;
  if (moves || !sameStoredRetryDeadline(args.nextRetryAfterAt, args.observedRetryAfterAt)) {
    return { retryAfterAt: args.nextRetryAfterAt, dispatchAttempts };
  }
  const base = args.observedRetryAfterAt?.getTime() ?? Date.now();
  return {
    retryAfterAt: new Date((Math.floor(base / 1000) + 1) * 1000),
    dispatchAttempts,
  };
}

/** Match an observed `retry_after_at`, including an unset deadline. */
export function retryAfterAtMatches(observed: Date | null): SQL {
  return observed == null
    ? isNull(actionInvocations.retryAfterAt)
    : eq(actionInvocations.retryAfterAt, observed);
}
