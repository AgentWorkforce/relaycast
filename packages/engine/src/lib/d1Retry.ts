const RETRYABLE_D1_ERRORS = [
  ['network_connection_lost', 'Network connection lost'],
  ['code_update_reset', 'D1 DB reset because its code was updated'],
  ['startup_storage_reset', 'Internal error while starting up D1 DB storage caused object to be reset'],
  ['storage_reset', 'Internal error in D1 DB storage caused object to be reset'],
  ['remote_node_transient', 'Cannot resolve D1 DB due to transient issue on remote node'],
  ['client_disconnected', "Can't read from request stream because client disconnected"],
  ['queue_timeout', 'D1 DB is overloaded. Requests queued for too long'],
  ['queue_full', 'D1 DB is overloaded. Too many requests queued'],
] as const;

export type RetryableD1ErrorCode = (typeof RETRYABLE_D1_ERRORS)[number][0];

export class D1WriteRetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly storageError: RetryableD1ErrorCode,
  ) {
    super('Transient D1 write failed after retry attempts');
    this.name = 'D1WriteRetryExhaustedError';
  }
}

function errorCause(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !('cause' in error)) return undefined;
  return (error as { cause?: unknown }).cause;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || !('message' in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * Classify only D1's own error message (including a nested Drizzle cause).
 * The outer Drizzle message contains SQL and bound parameters, so matching it
 * could mistake a user-controlled value for a retryable storage failure.
 */
export function retryableD1ErrorCode(error: unknown): RetryableD1ErrorCode | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; current !== undefined && depth < 6 && !seen.has(current); depth += 1) {
    seen.add(current);
    const message = errorMessage(current);

    if (message?.startsWith('D1_ERROR:')) {
      const match = RETRYABLE_D1_ERRORS.find(([, fragment]) => message.includes(fragment));
      return match?.[0];
    }
    current = errorCause(current);
  }

  return undefined;
}

function retryDelayMs(completedAttempts: number): number {
  const exponential = 50 * (2 ** (completedAttempts - 1));
  return exponential + Math.floor(Math.random() * exponential);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a D1 write only for Cloudflare's documented transient error classes. */
export async function retryD1Write<T>(
  write: () => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      const code = retryableD1ErrorCode(error);
      if (!code || attempt >= maxAttempts) {
        if (code) throw new D1WriteRetryExhaustedError(attempt, code);
        throw error;
      }
      await sleep(retryDelayMs(attempt));
    }
  }
}
