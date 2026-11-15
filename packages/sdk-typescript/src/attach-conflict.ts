/**
 * The engine/gateway refuses a `node.register` whose provider identity
 * collides with a still-live attachment of another instance: an `error` reply
 * with this code, followed by a close with {@link PROVIDER_INSTANCE_CONFLICT_CLOSE_CODE}.
 * The incumbent keeps the binding, so a refused client must wait rather than
 * reconnect at once (each immediate retry is refused the same way).
 */
export const PROVIDER_INSTANCE_CONFLICT_CODE = 'provider_instance_conflict';

/** WebSocket close code the gateway uses after a `provider_instance_conflict` refusal. */
export const PROVIDER_INSTANCE_CONFLICT_CLOSE_CODE = 4009;

/** Minimum wait before re-attaching after a conflict refusal. */
export const PROVIDER_INSTANCE_CONFLICT_MIN_RETRY_MS = 30_000;

/** Upper bound on a server-suggested retry wait, so a bad hint cannot park a client for hours. */
export const PROVIDER_INSTANCE_CONFLICT_MAX_RETRY_MS = 300_000;

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The minimum wait after a conflict refusal: the largest of the frame's
 * `retry_after_ms`, its `retry_after` (seconds) and
 * {@link PROVIDER_INSTANCE_CONFLICT_MIN_RETRY_MS}, capped at
 * {@link PROVIDER_INSTANCE_CONFLICT_MAX_RETRY_MS}. A missing or malformed hint
 * leaves the floor.
 */
export function conflictRetryDelayMs(frame?: Record<string, unknown> | null): number {
  let delay = PROVIDER_INSTANCE_CONFLICT_MIN_RETRY_MS;
  const ms = nonNegativeFinite(frame?.retry_after_ms);
  if (ms !== null) delay = Math.max(delay, ms);
  const seconds = nonNegativeFinite(frame?.retry_after);
  if (seconds !== null) delay = Math.max(delay, seconds * 1000);
  return Math.min(Math.ceil(delay), PROVIDER_INSTANCE_CONFLICT_MAX_RETRY_MS);
}

/** Read `code`/`reason` from a close event; some runtimes pass none. */
export function readCloseEvent(event: unknown): { code: number | null; reason: string } {
  if (event === null || typeof event !== 'object') return { code: null, reason: '' };
  const { code, reason } = event as { code?: unknown; reason?: unknown };
  return {
    code: typeof code === 'number' && Number.isFinite(code) ? code : null,
    reason: typeof reason === 'string' ? reason : '',
  };
}
