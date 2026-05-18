import { normalizeTelemetryOrigin, type TelemetryOrigin } from '@relaycast/types';

export type OriginInfo = Partial<TelemetryOrigin>;

/**
 * HTTP header used by orchestrators (Claude Code, Cursor, etc.) to identify
 * themselves to the relaycast server. See relay#881.
 */
export const ORCHESTRATOR_HARNESS_HEADER = 'X-Relaycast-Harness';

/** Fallback value when the header is missing or invalid. */
export const UNKNOWN_ORCHESTRATOR_HARNESS = 'unknown';

/** Sanity-cap on the header value — long enough for any reasonable identifier. */
const ORCHESTRATOR_HARNESS_MAX_LENGTH = 40;

/**
 * Read and sanitize the `X-Relaycast-Harness` header from a request.
 *
 * Returns a lowercase identifier (kebab-case by convention, e.g. `claude-code`,
 * `cursor`, `codex`). We intentionally do NOT enforce an enum here — accepting
 * any well-formed value lets us discover new harnesses without shipping a
 * relaycast release first. Segmentation/normalization happens downstream in
 * the analytics layer.
 *
 * Drops empty, oversized, or non-ASCII values to `'unknown'`.
 */
export function extractOrchestratorHarness(headers: Headers): string {
  const raw = headers.get(ORCHESTRATOR_HARNESS_HEADER);
  if (!raw) return UNKNOWN_ORCHESTRATOR_HARNESS;

  const trimmed = raw.trim();
  if (!trimmed) return UNKNOWN_ORCHESTRATOR_HARNESS;
  if (trimmed.length > ORCHESTRATOR_HARNESS_MAX_LENGTH) return UNKNOWN_ORCHESTRATOR_HARNESS;
  // Restrict to printable ASCII to keep PostHog property values clean. Allow
  // letters, digits, and the small set of separators harness names tend to
  // use. Anything else falls back to `unknown`.
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return UNKNOWN_ORCHESTRATOR_HARNESS;

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

  const querySurface = url.searchParams.get('origin_surface');
  const queryClient = url.searchParams.get('origin_client');
  const queryVersion = url.searchParams.get('origin_version');

  const originSurface = sanitizeOriginPart(
    headers.get('x-relaycast-origin-surface') ?? headers.get('x-origin-surface') ?? querySurface,
    32,
  );
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
    ...(originSurface ? { origin_surface: originSurface } : {}),
    ...(originClient ? { origin_client: originClient } : {}),
    ...(originVersion ? { origin_version: originVersion } : {}),
  };
}

export function requiredOriginInfo(request: Request, fallbackClientName?: string): TelemetryOrigin {
  return normalizeTelemetryOrigin(extractOriginInfo(request, fallbackClientName));
}
