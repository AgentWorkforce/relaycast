/**
 * Shared HMAC primitives for the STS broker.
 *
 * Worker → Lambda authenticates each broker request with HMAC-SHA256 over a
 * canonical string built from the request method, path, body, and a unix
 * timestamp. The Worker signs with `crypto.subtle` (Web Crypto), the Lambda
 * verifies with Node's `crypto`. To keep both halves in lock-step, the
 * canonicalization is defined here and imported from both sides.
 *
 * Anti-replay: the timestamp is part of the signed payload AND independently
 * checked for drift on the verify side (default 60s window). Without the
 * window, an attacker who recorded a single signed request could replay it
 * forever.
 */

export const REQUEST_SIGNATURE_HEADER = "x-request-signature";
export const REQUEST_TIMESTAMP_HEADER = "x-request-timestamp";

/**
 * Maximum clock skew between Worker and broker, in seconds. Picked to be
 * tight enough to bound replay risk but loose enough to absorb routine NTP
 * drift between CF edge nodes and us-east-1 Lambda hosts.
 */
export const DEFAULT_SIGNATURE_MAX_SKEW_SECONDS = 60;

/**
 * Canonical signing string. Order matters — both sides MUST produce the same
 * bytes for a given (method, path, body, timestamp) tuple.
 *
 * `path` is the request URL path WITHOUT host or query. Query string is not
 * signed because the broker only accepts POST bodies (no query parameters).
 * If we ever add query params, fold them into `path` before signing.
 */
export function buildSigningString(input: {
  method: string;
  path: string;
  body: string;
  timestamp: string;
}): string {
  return `${input.method.toUpperCase()}\n${input.path}\n${input.body}\n${input.timestamp}`;
}

/**
 * Constant-time string comparison. Both `crypto.timingSafeEqual` (Node) and
 * `subtle.verify` (Worker) provide this natively at the byte level, but
 * callers sometimes need to compare base64 strings before decoding to bytes
 * (e.g. for header presence checks). This helper keeps the comparison
 * timing-safe even on platforms where the byte-level path isn't reachable.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Reject obviously malformed or stale timestamps before reaching into HMAC
 * verify. `nowSeconds` is injectable for tests.
 */
export function isTimestampWithinWindow(
  timestamp: string,
  options: { maxSkewSeconds?: number; nowSeconds?: number } = {},
): boolean {
  const max = options.maxSkewSeconds ?? DEFAULT_SIGNATURE_MAX_SKEW_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const parsed = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return false;
  }
  return Math.abs(now - parsed) <= max;
}
