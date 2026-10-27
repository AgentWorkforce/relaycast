import { SDK_VERSION } from './version.js';

export interface InternalOrigin {
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
  /**
   * Optional Agent Relay Cloud user id of the signed-in operator. Relaycast has
   * no user table of its own, so hosts that know who is driving the process
   * forward it here to let server-side telemetry report real users and orgs
   * rather than only workspaces.
   */
  agentRelayUserId?: string;
  /**
   * Optional hashed machine id of the host process. Sent alongside the distinct
   * id, never instead of it: after login the distinct id is the user id, so this
   * is what keeps machine-level cross-tabs (machines per workspace, accounts per
   * machine) answerable server-side.
   */
  agentRelayMachineId?: string;
  /** Optional Agent Relay Cloud organization id, for group analytics. */
  agentRelayOrgId?: string;
  /** Optional organization slug, for readable analytics breakdowns. */
  agentRelayOrgSlug?: string;
}

export const SDK_ORIGIN: InternalOrigin = Object.freeze({
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
export const AGENT_RELAY_MACHINE_ID_HEADER = 'X-Agent-Relay-Machine-Id';
export const AGENT_RELAY_MACHINE_ID_QUERY = 'agent_relay_machine_id';
export const AGENT_RELAY_USER_ID_HEADER = 'X-Agent-Relay-User-Id';
export const AGENT_RELAY_USER_ID_QUERY = 'agent_relay_user_id';
export const AGENT_RELAY_ORG_ID_HEADER = 'X-Agent-Relay-Org-Id';
export const AGENT_RELAY_ORG_ID_QUERY = 'agent_relay_org_id';
export const AGENT_RELAY_ORG_SLUG_HEADER = 'X-Agent-Relay-Org-Slug';
export const AGENT_RELAY_ORG_SLUG_QUERY = 'agent_relay_org_slug';

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

/** Identity ids share the distinct-id contract: same charset, same length cap. */
export const sanitizeAgentRelayUserId = sanitizeAgentRelayDistinctId;
export const sanitizeAgentRelayMachineId = sanitizeAgentRelayDistinctId;
export const sanitizeAgentRelayOrgId = sanitizeAgentRelayDistinctId;

export function sanitizeAgentRelayOrgSlug(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_DISTINCT_ID_ALLOWED.test(trimmed)) return undefined;
  return trimmed.slice(0, 120);
}

/**
 * Resolved identity for a client, normalized once at construction.
 *
 * A signed-in user id doubles as the distinct id, so a host that knows the user
 * doesn't have to set both — the two sides stay on one PostHog person either way.
 */
export interface AgentRelayIdentity {
  distinctId?: string;
  machineId?: string;
  userId?: string;
  orgId?: string;
  orgSlug?: string;
}

export function resolveAgentRelayIdentity(
  ...sources: Array<Partial<InternalOrigin> | undefined>
): AgentRelayIdentity {
  /**
   * First candidate that survives sanitization wins.
   *
   * Sanitizing inside the loop rather than after it matters: a malformed
   * higher-priority value would otherwise shadow a valid lower-priority one and
   * drop the dimension entirely, so a wrapping host with a bad internal value
   * silently lost identity the caller had supplied correctly.
   */
  const pick = (
    key: keyof InternalOrigin,
    sanitize: (raw: string | undefined) => string | undefined
  ): string | undefined => {
    for (const source of sources) {
      const value = source?.[key];
      if (typeof value !== 'string') continue;
      const sanitized = sanitize(value);
      if (sanitized) return sanitized;
    }
    return undefined;
  };

  const userId = pick('agentRelayUserId', sanitizeAgentRelayUserId);
  const machineId = pick('agentRelayMachineId', sanitizeAgentRelayMachineId);
  const orgId = pick('agentRelayOrgId', sanitizeAgentRelayOrgId);
  const orgSlug = pick('agentRelayOrgSlug', sanitizeAgentRelayOrgSlug);
  const distinctId =
    pick('agentRelayDistinctId', sanitizeAgentRelayDistinctId) ?? userId ?? machineId;

  return {
    ...(distinctId ? { distinctId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(userId ? { userId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(orgSlug ? { orgSlug } : {}),
  };
}

/**
 * Project a resolved identity back onto the {@link InternalOrigin} fields.
 *
 * Every place that hands identity to another client (`withApiKey`, and the
 * WebSocket clients built by `RelayCast` and `AgentClient`) goes through this
 * rather than spreading the fields by hand — that duplication is how the agent
 * socket silently missed the user/machine/org dimensions when they were added.
 */
export function agentRelayIdentityOrigin(
  identity: AgentRelayIdentity
): Partial<InternalOrigin> {
  return {
    ...(identity.distinctId ? { agentRelayDistinctId: identity.distinctId } : {}),
    ...(identity.machineId ? { agentRelayMachineId: identity.machineId } : {}),
    ...(identity.userId ? { agentRelayUserId: identity.userId } : {}),
    ...(identity.orgId ? { agentRelayOrgId: identity.orgId } : {}),
    ...(identity.orgSlug ? { agentRelayOrgSlug: identity.orgSlug } : {}),
  };
}

/** Identity headers for an HTTP request. Omits anything unset. */
export function agentRelayIdentityHeaders(
  identity: AgentRelayIdentity
): Record<string, string> {
  return {
    ...(identity.distinctId ? { [AGENT_RELAY_DISTINCT_ID_HEADER]: identity.distinctId } : {}),
    ...(identity.machineId ? { [AGENT_RELAY_MACHINE_ID_HEADER]: identity.machineId } : {}),
    ...(identity.userId ? { [AGENT_RELAY_USER_ID_HEADER]: identity.userId } : {}),
    ...(identity.orgId ? { [AGENT_RELAY_ORG_ID_HEADER]: identity.orgId } : {}),
    ...(identity.orgSlug ? { [AGENT_RELAY_ORG_SLUG_HEADER]: identity.orgSlug } : {}),
  };
}

/**
 * Identity query params for a WebSocket upgrade — browsers can't set custom
 * headers on a WS handshake, so the same values ride the query string.
 */
export function applyAgentRelayIdentityQuery(
  url: URL,
  identity: AgentRelayIdentity
): void {
  if (identity.distinctId) {
    url.searchParams.set(AGENT_RELAY_DISTINCT_ID_QUERY, identity.distinctId);
  }
  if (identity.machineId) {
    url.searchParams.set(AGENT_RELAY_MACHINE_ID_QUERY, identity.machineId);
  }
  if (identity.userId) {
    url.searchParams.set(AGENT_RELAY_USER_ID_QUERY, identity.userId);
  }
  if (identity.orgId) {
    url.searchParams.set(AGENT_RELAY_ORG_ID_QUERY, identity.orgId);
  }
  if (identity.orgSlug) {
    url.searchParams.set(AGENT_RELAY_ORG_SLUG_QUERY, identity.orgSlug);
  }
}
