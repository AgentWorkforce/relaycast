import {
  normalizeTelemetryOrigin,
  type TelemetryOrigin,
} from "@relaycast/types";

export type OriginInfo = Partial<TelemetryOrigin>;

/**
 * HTTP header used by callers to identify *who* is driving a request — a
 * UA-style path `{app}/{type}[/{name}]` (e.g. `agent-relay-cli/agent/claude-code`,
 * `pear/user/send-message-box`). See `cloud/plans/origin-actor.md`. Supersedes
 * the former `X-Relaycast-Harness` (relay#881).
 */
export const ORIGIN_ACTOR_HEADER = "X-Relaycast-Origin-Actor";
export const ORIGIN_ACTOR_QUERY = "origin_actor";
export const AGENT_RELAY_DISTINCT_ID_HEADER = "X-Agent-Relay-Distinct-Id";
export const AGENT_RELAY_DISTINCT_ID_QUERY = "agent_relay_distinct_id";

/**
 * Who — as a machine, a person, and an organization — is behind this request.
 *
 * A relaycast workspace is an API-key row; it has no user table, so the gateway
 * cannot derive a human identity on its own. Callers that *do* know one (the
 * Agent Relay CLI and broker, after `agent-relay cloud login`) forward it here
 * so server-side product events can be grouped by machine, user, and org
 * instead of only by workspace.
 *
 * All four are optional and untrusted: they are analytics dimensions only and
 * must never gate authorization.
 */
export const AGENT_RELAY_MACHINE_ID_HEADER = "X-Agent-Relay-Machine-Id";
export const AGENT_RELAY_MACHINE_ID_QUERY = "agent_relay_machine_id";
export const AGENT_RELAY_USER_ID_HEADER = "X-Agent-Relay-User-Id";
export const AGENT_RELAY_USER_ID_QUERY = "agent_relay_user_id";
export const AGENT_RELAY_ORG_ID_HEADER = "X-Agent-Relay-Org-Id";
export const AGENT_RELAY_ORG_ID_QUERY = "agent_relay_org_id";
export const AGENT_RELAY_ORG_SLUG_HEADER = "X-Agent-Relay-Org-Slug";
export const AGENT_RELAY_ORG_SLUG_QUERY = "agent_relay_org_slug";

/** Fallback value when the origin actor is missing or invalid. */
export const UNKNOWN_ORIGIN_ACTOR = "unknown";

/** Upper bound on the origin-actor value — generous enough for a UA-style path. */
const ORIGIN_ACTOR_MAX_LENGTH = 128;

/**
 * Characters permitted in an origin-actor path. Deliberately broad enough for a
 * User-Agent-style token with `/`-separated segments (`{app}/{type}/{name}`,
 * `name/version (model=...; setting)`) while excluding CR/LF and other control
 * characters — rejecting those is what keeps a buggy upstream caller from
 * smuggling a header injection past the relaycast WAF.
 */
const ORIGIN_ACTOR_ALLOWED = /^[a-z0-9 ._\-/():=;,+@]+$/i;
const AGENT_RELAY_DISTINCT_ID_ALLOWED = /^[a-z0-9._:-]+$/i;

/**
 * Read and sanitize the origin-actor path from a request.
 *
 * Read from the `X-Relaycast-Origin-Actor` header, falling back to the
 * `origin_actor` query param (WebSocket upgrades from browsers can't set custom
 * headers, so the SDK forwards it on the query string — mirrors how origin
 * fields work).
 *
 * Returns a lowercase, UA-style path (e.g. `agent-relay-cli/agent/claude-code`).
 * We intentionally do NOT enforce an enum here — accepting any well-formed value
 * lets us discover new apps/actors without shipping a relaycast release first;
 * the `{app}/{type}/{name}` split happens downstream in the analytics layer.
 * Drops empty or malformed values to `'unknown'`.
 */
export function extractOriginActor(request: Request): string {
  const raw =
    request.headers.get(ORIGIN_ACTOR_HEADER) ??
    new URL(request.url).searchParams.get(ORIGIN_ACTOR_QUERY);
  if (!raw) return UNKNOWN_ORIGIN_ACTOR;

  const trimmed = raw.trim();
  if (!trimmed) return UNKNOWN_ORIGIN_ACTOR;
  if (!ORIGIN_ACTOR_ALLOWED.test(trimmed)) return UNKNOWN_ORIGIN_ACTOR;

  return trimmed.slice(0, ORIGIN_ACTOR_MAX_LENGTH).toLowerCase();
}

export function extractAgentRelayDistinctId(
  request: Request,
): string | undefined {
  return readIdentityValue(
    request,
    AGENT_RELAY_DISTINCT_ID_HEADER,
    AGENT_RELAY_DISTINCT_ID_QUERY,
    { maxLength: 128, onOversize: "truncate" },
  );
}

/**
 * Read one identity dimension from a header, falling back to a query param —
 * WebSocket upgrades from browsers can't set custom headers, so the SDK forwards
 * these on the query string (mirrors how `origin_actor` works).
 *
 * Anything outside the distinct-id charset is dropped, which keeps a malformed
 * upstream value from smuggling a header injection or a misleading id into
 * analytics.
 *
 * `onOversize` differs by dimension on purpose:
 *   - `reject` for the actor dimensions. A truncated user or org id is a
 *     *different* id that can collide with a real one and attribute usage to
 *     the wrong person or company, so no attribution beats wrong attribution.
 *     Every SDK caps well below these limits, so only a malformed caller hits it.
 *   - `truncate` for `agent_relay_distinct_id`, whose cap-at-128 behaviour is
 *     already shipped and covered by a test; changing it is out of scope here.
 */
function readIdentityValue(
  request: Request,
  header: string,
  query: string,
  { maxLength, onOversize }: { maxLength: number; onOversize: "reject" | "truncate" },
): string | undefined {
  const raw =
    request.headers.get(header) ??
    new URL(request.url).searchParams.get(query);
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_DISTINCT_ID_ALLOWED.test(trimmed)) return undefined;
  if (trimmed.length > maxLength) {
    return onOversize === "reject" ? undefined : trimmed.slice(0, maxLength);
  }

  return trimmed;
}

export interface ActorIdentity {
  /**
   * Hashed machine id of the host that made the request.
   *
   * Reported alongside the user id rather than instead of it, which is what
   * makes the cross-tabs possible: how many machines share one workspace
   * (`actor_machine_id` per `workspace_id`), and whether those machines are
   * signed into one account or several (`actor_user_id` per
   * `actor_machine_id`).
   */
  actor_machine_id?: string;
  /** Agent Relay Cloud user id of the operator behind the request. */
  actor_user_id?: string;
  /** Agent Relay Cloud organization id, used for PostHog group analytics. */
  actor_org_id?: string;
  /** Organization slug, for breakdowns that shouldn't show opaque ids. */
  actor_org_slug?: string;
}

/**
 * Extract the caller-declared user/org identity. Returns an object with only the
 * fields that were present and well-formed, so it can be spread straight into
 * telemetry properties without emitting empty values.
 */
export function extractActorIdentity(request: Request): ActorIdentity {
  const machineId = readIdentityValue(
    request,
    AGENT_RELAY_MACHINE_ID_HEADER,
    AGENT_RELAY_MACHINE_ID_QUERY,
    { maxLength: 128, onOversize: "reject" },
  );
  const userId = readIdentityValue(
    request,
    AGENT_RELAY_USER_ID_HEADER,
    AGENT_RELAY_USER_ID_QUERY,
    { maxLength: 128, onOversize: "reject" },
  );
  const orgId = readIdentityValue(
    request,
    AGENT_RELAY_ORG_ID_HEADER,
    AGENT_RELAY_ORG_ID_QUERY,
    { maxLength: 128, onOversize: "reject" },
  );
  const orgSlug = readIdentityValue(
    request,
    AGENT_RELAY_ORG_SLUG_HEADER,
    AGENT_RELAY_ORG_SLUG_QUERY,
    { maxLength: 120, onOversize: "reject" },
  );

  return {
    ...(machineId ? { actor_machine_id: machineId } : {}),
    ...(userId ? { actor_user_id: userId } : {}),
    ...(orgId ? { actor_org_id: orgId } : {}),
    ...(orgSlug ? { actor_org_slug: orgSlug } : {}),
  };
}

function sanitizeOriginPart(
  value: string | null | undefined,
  maxLen: number,
): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLen);
}

export function deriveClientName(headers: Headers): string | undefined {
  const explicit =
    headers.get("x-client-name") ?? headers.get("x-relaycast-client");
  if (explicit) return explicit.trim().slice(0, 80);

  const ua = headers.get("user-agent");
  if (!ua) return undefined;
  const family = ua.split(/[\/\s;]/)[0];
  return family ? family.trim().slice(0, 80) : undefined;
}

export function extractOriginInfo(
  request: Request,
  fallbackClientName?: string,
): OriginInfo {
  const headers = request.headers;
  const url = new URL(request.url);

  const queryClient = url.searchParams.get("origin_client");
  const queryVersion = url.searchParams.get("origin_version");

  const originClient = sanitizeOriginPart(
    headers.get("x-relaycast-origin-client") ??
      headers.get("x-origin-client") ??
      queryClient ??
      fallbackClientName,
    80,
  );
  const originVersion = sanitizeOriginPart(
    headers.get("x-relaycast-origin-version") ??
      headers.get("x-origin-version") ??
      queryVersion ??
      headers.get("x-sdk-version"),
    48,
  );

  return {
    ...(originClient ? { origin_client: originClient } : {}),
    ...(originVersion ? { origin_version: originVersion } : {}),
  };
}

export function requiredOriginInfo(
  request: Request,
  fallbackClientName?: string,
): TelemetryOrigin {
  return normalizeTelemetryOrigin(
    extractOriginInfo(request, fallbackClientName),
  );
}
