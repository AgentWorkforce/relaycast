import { SDK_VERSION } from './version.js';

export interface InternalOrigin {
  surface: string;
  client: string;
  version: string;
  /**
   * Optional User-Agent-style identifier for the harness driving the process
   * (e.g. `claude-code/2.3 (model=opus-4.8; fast)`, `codex`, `human`). Wrapping
   * hosts set this so server-side telemetry can attribute requests to a harness.
   * See {@link sanitizeHarness} for the accepted shape.
   */
  harness?: string;
  /**
   * Optional Agent Relay anonymous installation id. Wrapping hosts set this so
   * Relaycast telemetry can join SDK traffic back to Agent Relay CLI telemetry
   * without sending user-identifying data.
   */
  agentRelayAnonymousId?: string;
}

export const SDK_ORIGIN: InternalOrigin = Object.freeze({
  surface: 'sdk',
  client: '@relaycast/sdk',
  version: SDK_VERSION,
});

/**
 * HTTP header (and WS query param) used to tell the relaycast server which
 * harness is driving the request. Mirrors the server-side contract in
 * `@relaycast/engine`'s `extractHarness`.
 */
export const HARNESS_HEADER = 'X-Relaycast-Harness';
export const AGENT_RELAY_ANONYMOUS_ID_HEADER = 'X-Agent-Relay-Anonymous-Id';
export const AGENT_RELAY_ANONYMOUS_ID_QUERY = 'agent_relay_anonymous_id';

/** Upper bound on the harness identifier — generous enough for a UA-style token. */
const HARNESS_MAX_LENGTH = 120;
const AGENT_RELAY_ANONYMOUS_ID_MAX_LENGTH = 128;

/**
 * Characters permitted in a harness identifier. Deliberately broad enough for a
 * User-Agent-style token (`name/version (model=...; setting)`) while excluding
 * CR/LF and other control characters — dropping those is what keeps a malformed
 * upstream value from smuggling a header injection past the relaycast WAF.
 */
const HARNESS_ALLOWED = /^[a-z0-9 ._\-/():=;,+]+$/i;
const AGENT_RELAY_ANONYMOUS_ID_ALLOWED = /^[a-z0-9._:-]+$/i;

/**
 * Normalize a caller-supplied harness identifier to the wire contract.
 *
 * Returns a lowercased, length-capped token, or `undefined` when the input is
 * empty or contains disallowed characters — in which case callers omit the
 * header entirely rather than sending garbage the server would reject anyway.
 */
export function sanitizeHarness(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!HARNESS_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, HARNESS_MAX_LENGTH).toLowerCase();
}

export function sanitizeAgentRelayAnonymousId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_ANONYMOUS_ID_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, AGENT_RELAY_ANONYMOUS_ID_MAX_LENGTH);
}
