import { SDK_VERSION } from './version.js';

export interface InternalOrigin {
  surface: string;
  client: string;
  version: string;
  /**
   * Optional parent orchestrator harness slug (e.g. `claude-code`, `cursor`,
   * `codex`). When set, the HTTP client stamps `X-Relaycast-Harness` on every
   * request and the WS client forwards it via the `harness` query param. The
   * server side reads either and tags `orchestrator_harness` on telemetry
   * events.
   *
   * Set by callers that wrap the SDK from a host (e.g. `@agent-relay/relaycast-mcp`)
   * via `createInternalRelayCast(opts, origin)`. Plain `new RelayCast(...)`
   * consumers don't need to populate it — the field is opt-in.
   */
  harness?: string;
}

export const SDK_ORIGIN: InternalOrigin = Object.freeze({
  surface: 'sdk',
  client: '@relaycast/sdk',
  version: SDK_VERSION,
});

/**
 * Sanitize a harness slug to the relaycast server-side contract:
 *   lowercase, ASCII-only, max 40 chars, hyphen-friendly.
 *
 * Anything outside the allowed shape collapses to `undefined` so the header
 * is simply omitted (the server treats absence as `unknown`). Keeps the
 * client side from sending garbage we know the server will reject.
 */
export function sanitizeHarness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  // ASCII letters, digits, hyphens. Reject anything else outright.
  if (!/^[a-z0-9-]+$/.test(trimmed)) return undefined;
  return trimmed.length > 40 ? trimmed.slice(0, 40) : trimmed;
}
