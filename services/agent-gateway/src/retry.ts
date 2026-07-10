export class NoRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRetry";
  }
}

export type RetryPolicy = {
  maxAttempts: number;
  delaysMs: number[];
  jitterRatio: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  delaysMs: [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000],
  jitterRatio: 0.2,
};

export function shouldRetry(
  attempt: number,
  error: unknown,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): boolean {
  if (error instanceof NoRetry) {
    return false;
  }
  return attempt < policy.maxAttempts;
}

export function computeRetryDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  const index = Math.max(0, Math.min(policy.delaysMs.length - 1, attempt - 1));
  const baseDelay = policy.delaysMs[index] ?? policy.delaysMs.at(-1) ?? 1_000;
  const jitterWindow = Math.max(1, Math.floor(baseDelay * policy.jitterRatio));
  const jitter = Math.floor(Math.random() * jitterWindow);
  return baseDelay + jitter;
}
