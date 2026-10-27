/** Yield before re-reading an invocation whose winning dispatch is still pending. */
export function waitForPendingInvocationRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
