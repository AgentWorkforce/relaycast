import { SDK_VERSION } from './version.js';

export interface InternalOrigin {
  surface: string;
  client: string;
  version: string;
  /**
   * Optional User-Agent-style identifier for the originActor driving the process
   * (e.g. `claude-code/2.3 (model=opus-4.8; fast)`, `codex`, `human`). Wrapping
   * hosts set this so server-side telemetry can attribute requests to a originActor.
   * See {@link sanitizeOriginActor} for the accepted shape.
   */
  originActor?: string;
  /**
   * Optional Agent Relay distinct telemetry id. Wrapping hosts set this so
   * Relaycast telemetry can join SDK traffic back to Agent Relay CLI telemetry
   * without sending user-identifying data.
   */
  agentRelayDistinctId?: string;
}

export const SDK_ORIGIN: InternalOrigin = Object.freeze({
  surface: 'sdk',
  client: '@relaycast/sdk',
  version: SDK_VERSION,
});

/**
 * HTTP header (and WS query param) used to tell the relaycast server which
 * originActor is driving the request. Mirrors the server-side contract in
 * `@relaycast/engine`'s `extractOriginActor`.
 */
export const ORIGIN_ACTOR_HEADER = 'X-Relaycast-Origin-Actor';
export const AGENT_RELAY_DISTINCT_ID_HEADER = 'X-Agent-Relay-Distinct-Id';
export const AGENT_RELAY_DISTINCT_ID_QUERY = 'agent_relay_distinct_id';

/** Upper bound on the originActor identifier — generous enough for a UA-style token. */
const ORIGIN_ACTOR_MAX_LENGTH = 128;
const AGENT_RELAY_DISTINCT_ID_MAX_LENGTH = 128;

/**
 * Characters permitted in a originActor identifier. Deliberately broad enough for a
 * User-Agent-style token (`name/version (model=...; setting)`) while excluding
 * CR/LF and other control characters — dropping those is what keeps a malformed
 * upstream value from smuggling a header injection past the relaycast WAF.
 */
const ORIGIN_ACTOR_ALLOWED = /^[a-z0-9 ._\-/():=;,+@]+$/i;
const AGENT_RELAY_DISTINCT_ID_ALLOWED = /^[a-z0-9._:-]+$/i;

/**
 * Normalize a caller-supplied originActor identifier to the wire contract.
 *
 * Returns a lowercased, length-capped token, or `undefined` when the input is
 * empty or contains disallowed characters — in which case callers omit the
 * header entirely rather than sending garbage the server would reject anyway.
 */
export function sanitizeOriginActor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!ORIGIN_ACTOR_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, ORIGIN_ACTOR_MAX_LENGTH).toLowerCase();
}

export function sanitizeAgentRelayDistinctId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_DISTINCT_ID_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, AGENT_RELAY_DISTINCT_ID_MAX_LENGTH);
}
