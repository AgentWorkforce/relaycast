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
  const raw =
    request.headers.get(AGENT_RELAY_DISTINCT_ID_HEADER) ??
    new URL(request.url).searchParams.get(AGENT_RELAY_DISTINCT_ID_QUERY);
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_DISTINCT_ID_ALLOWED.test(trimmed)) return undefined;

  return trimmed.slice(0, 128);
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
