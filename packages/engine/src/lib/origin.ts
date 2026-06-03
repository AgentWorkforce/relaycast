import {
  normalizeTelemetryOrigin,
  type TelemetryOrigin,
} from "@relaycast/types";

export type OriginInfo = Partial<TelemetryOrigin>;

/**
 * HTTP header used by harnesses (Claude Code, Cursor, etc.) to identify
 * themselves to the relaycast server. See relay#881.
 */
export const HARNESS_HEADER = "X-Relaycast-Harness";
export const AGENT_RELAY_ANONYMOUS_ID_HEADER = "X-Agent-Relay-Anonymous-Id";

/** Fallback value when the harness is missing or invalid. */
export const UNKNOWN_HARNESS = "unknown";

/** Upper bound on the harness value — generous enough for a UA-style token. */
const HARNESS_MAX_LENGTH = 120;

/**
 * Characters permitted in a harness identifier. Deliberately broad enough for a
 * User-Agent-style token (`name/version (model=...; setting)`) while excluding
 * CR/LF and other control characters — rejecting those is what keeps a buggy
 * upstream caller from smuggling a header injection past the relaycast WAF.
 */
const HARNESS_ALLOWED = /^[a-z0-9 ._\-/():=;,+]+$/i;
const AGENT_RELAY_ANONYMOUS_ID_ALLOWED = /^[a-z0-9._:-]+$/i;

/**
 * Read and sanitize the harness identifier from a request.
 *
 * Read from the `X-Relaycast-Harness` header, falling back to the `harness`
 * query param (WebSocket upgrades from browsers can't set custom headers, so
 * the SDK forwards it on the query string — mirrors how origin fields work).
 *
 * Returns a lowercase, UA-style identifier (e.g. `claude-code`, `codex`,
 * `claude-code/2.3 (model=opus-4.8; fast)`). We intentionally do NOT enforce an
 * enum here — accepting any well-formed value lets us discover new harnesses
 * without shipping a relaycast release first; segmentation happens downstream
 * in the analytics layer. Drops empty or malformed values to `'unknown'`.
 */
export function extractHarness(request: Request): string {
  const raw =
    request.headers.get(HARNESS_HEADER) ??
    new URL(request.url).searchParams.get("harness");
  if (!raw) return UNKNOWN_HARNESS;

  const trimmed = raw.trim();
  if (!trimmed) return UNKNOWN_HARNESS;
  if (!HARNESS_ALLOWED.test(trimmed)) return UNKNOWN_HARNESS;

  return trimmed.slice(0, HARNESS_MAX_LENGTH).toLowerCase();
}

export function extractAgentRelayAnonymousId(
  request: Request,
): string | undefined {
  const raw =
    request.headers.get(AGENT_RELAY_ANONYMOUS_ID_HEADER) ??
    new URL(request.url).searchParams.get("agent_relay_anonymous_id");
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!AGENT_RELAY_ANONYMOUS_ID_ALLOWED.test(trimmed)) return undefined;

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

  const querySurface = url.searchParams.get("origin_surface");
  const queryClient = url.searchParams.get("origin_client");
  const queryVersion = url.searchParams.get("origin_version");

  const originSurface = sanitizeOriginPart(
    headers.get("x-relaycast-origin-surface") ??
      headers.get("x-origin-surface") ??
      querySurface,
    32,
  );
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
    ...(originSurface ? { origin_surface: originSurface } : {}),
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
