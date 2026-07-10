import { normalizeTelemetryOrigin, type TelemetryOrigin } from '@relaycast/types';

export type OriginInfo = Partial<TelemetryOrigin>;

/**
 * HTTP header identifying *who* drives a request — a UA-style path
 * `{app}/{type}[/{name}]` (e.g. `agent-relay-cli/agent/claude-code@2.3.1-opus4.8`,
 * `pear/user/send-message-box`). See cloud/plans/origin-actor.md.
 */
export const ORIGIN_ACTOR_HEADER = 'X-Relaycast-Origin-Actor';

/** Fallback value when the header is missing or invalid. */
export const UNKNOWN_ORIGIN_ACTOR = 'unknown';

/** Sanity-cap on the value — long enough for `{app}/{type}/{name}@version-model`. */
const ORIGIN_ACTOR_MAX_LENGTH = 128;

/**
 * Read and sanitize the `X-Relaycast-Origin-Actor` header from a request.
 *
 * Returns a lowercased UA-style path. We intentionally do NOT enforce an enum
 * here — accepting any well-formed value lets us discover new apps/actors
 * without shipping a relaycast release first; the `{app}/{type}/{name}` split
 * happens downstream in the analytics layer.
 *
 * Drops empty, oversized, or non-ASCII values to `'unknown'`.
 */
export function extractOriginActor(headers: Headers): string {
  const raw = headers.get(ORIGIN_ACTOR_HEADER);
  if (!raw) return UNKNOWN_ORIGIN_ACTOR;

  const trimmed = raw.trim();
  if (!trimmed) return UNKNOWN_ORIGIN_ACTOR;
  if (trimmed.length > ORIGIN_ACTOR_MAX_LENGTH) return UNKNOWN_ORIGIN_ACTOR;
  // Restrict to printable ASCII to keep PostHog property values clean: letters,
  // digits, the segment separator `/`, the `@` (name@version), and the small
  // set of separators identifiers use. Anything else falls back to `unknown`.
  if (!/^[a-zA-Z0-9._\-/@]+$/.test(trimmed)) return UNKNOWN_ORIGIN_ACTOR;

  return trimmed.toLowerCase();
}

function sanitizeOriginPart(value: string | null | undefined, maxLen: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLen);
}

export function deriveClientName(headers: Headers): string | undefined {
  const explicit = headers.get('x-client-name') ?? headers.get('x-relaycast-client');
  if (explicit) return explicit.trim().slice(0, 80);

  const ua = headers.get('user-agent');
  if (!ua) return undefined;
  const family = ua.split(/[\/\s;]/)[0];
  return family ? family.trim().slice(0, 80) : undefined;
}

export function extractOriginInfo(request: Request, fallbackClientName?: string): OriginInfo {
  const headers = request.headers;
  const url = new URL(request.url);

  const queryClient = url.searchParams.get('origin_client');
  const queryVersion = url.searchParams.get('origin_version');

  const originClient = sanitizeOriginPart(
    headers.get('x-relaycast-origin-client')
      ?? headers.get('x-origin-client')
      ?? queryClient
      ?? fallbackClientName,
    80,
  );
  const originVersion = sanitizeOriginPart(
    headers.get('x-relaycast-origin-version')
      ?? headers.get('x-origin-version')
      ?? queryVersion
      ?? headers.get('x-sdk-version'),
    48,
  );

  return {
    ...(originClient ? { origin_client: originClient } : {}),
    ...(originVersion ? { origin_version: originVersion } : {}),
  };
}

export function requiredOriginInfo(request: Request, fallbackClientName?: string): TelemetryOrigin {
  return normalizeTelemetryOrigin(extractOriginInfo(request, fallbackClientName));
}
