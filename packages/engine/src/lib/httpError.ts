import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { jsonError, jsonMalformedBody } from './httpResponse.js';

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

/**
 * Narrow an unknown thrown value to a {@link CodedError} without asserting.
 * Plain (non-`Error`) objects are wrapped while preserving their own properties
 * — so a thrown `{ code, status, message }` still surfaces its `code`/`status`,
 * matching the behavior of the `err as Error & {...}` reads this replaces.
 */
export function asCodedError(err: unknown): CodedError {
  if (err instanceof Error) return err as CodedError;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const message = 'message' in err ? String((err as { message: unknown }).message) : 'Unknown error';
    const error = Object.assign(new Error(message), err);
    error.message = message;
    return error as CodedError;
  }
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
  if (error.message?.includes('JSON')) {
    return jsonMalformedBody(c);
  }
  return jsonError(
    c,
    error.code || 'internal_error',
    error.message,
    (error.status || 500) as ContentfulStatusCode,
  );
}
