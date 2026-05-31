import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Errors thrown inside the engine optionally carry a stable error `code` and an
 * HTTP `status`. They are plain `Error`s with those fields assigned (see
 * `Object.assign(err, { code, status })` throughout the engine), so this is the
 * one place that narrows an unknown thrown value into that shape.
 */
export interface CodedError extends Error {
  code?: string;
  status?: number;
}

/** Narrow an unknown thrown value to a {@link CodedError} without asserting. */
export function asCodedError(err: unknown): CodedError {
  if (err instanceof Error) return err as CodedError;
  return new Error(typeof err === 'string' ? err : 'Unknown error');
}

/** Build an `Error` carrying a stable `code` and HTTP `status` (no cast at the call site). */
export function codedError(message: string, code: string, status: number): CodedError {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Render a thrown value as the standard `{ ok: false, error: { code, message } }`
 * envelope with the carried (or default 500) status. Centralizes the single
 * `as ContentfulStatusCode` cast that Hono's typed status requires, behind a
 * real `instanceof` narrowing instead of the unchecked `err as Error & {...}`
 * assertion that was duplicated across every route handler.
 */
export function errorResponse(c: Context, err: unknown) {
  const error = asCodedError(err);
  return c.json(
    {
      ok: false as const,
      error: { code: error.code || 'internal_error', message: error.message },
    },
    (error.status || 500) as ContentfulStatusCode,
  );
}
