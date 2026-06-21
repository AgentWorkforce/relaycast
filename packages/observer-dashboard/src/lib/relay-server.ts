import type { NextRequest } from 'next/server';

function normalizeHost(host: string | null | undefined): string {
  if (!host) return '';
  const first = host.split(',')[0] ?? '';
  const trimmed = first.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.split(':')[0] ?? '';
}

function isLocalHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  );
}

/**
 * Resolve the ordered list of Relay engine base URLs to try for an observer host.
 *
 * Production resolves to the hosted engine (`cast.agentrelay.com`); the legacy
 * `gateway.relaycast.dev` / `api.relaycast.dev` engines have been decommissioned
 * and are no longer probed. Callers probe the candidates in order and keep the
 * first one that accepts the workspace key.
 *
 * Examples:
 * - observer.relaycast.dev -> [cast.agentrelay.com]
 * - pr23-observer.relaycast.dev -> [pr23-gateway.relaycast.dev, pr23-api.relaycast.dev]
 *
 * Per-environment gateway hostnames (`staging-gateway`, `prNN-gateway`) are
 * assumed to mirror the `-api` naming. If a gateway host does not exist for an
 * environment, the probe simply fails over to its `-api` counterpart, so the
 * assumption carries no risk.
 */
export function resolveRelayServerCandidatesFromHost(
  host: string | null | undefined
): string[] {
  const normalized = normalizeHost(host);

  // An explicit override pins a single engine (self-hosted / local dev).
  const override = process.env.RELAY_SERVER_URL;
  if (override) {
    return [override];
  }

  if (!normalized || isLocalHost(normalized)) {
    return ['http://localhost:3890'];
  }

  // Accept both custom domains and workers/pages preview hostnames that begin with prNN-observer.
  const prMatch = normalized.match(/^pr(\d+)-observer(?:[.-]|$)/);
  if (prMatch) {
    const n = prMatch[1];
    return [
      `https://pr${n}-gateway.relaycast.dev`,
      `https://pr${n}-api.relaycast.dev`,
    ];
  }

  if (normalized === 'staging-observer.relaycast.dev') {
    return [
      'https://staging-gateway.relaycast.dev',
      'https://staging-api.relaycast.dev',
    ];
  }

  return ['https://cast.agentrelay.com'];
}

export function resolveRelayServerCandidatesFromRequest(
  request: NextRequest | Request
): string[] {
  const observerHost = request.headers.get('x-relaycast-observer-host');
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = request.headers.get('host');
  return resolveRelayServerCandidatesFromHost(
    observerHost ?? forwardedHost ?? host
  );
}

/**
 * Resolve the single happy-path engine URL for an observer host (first
 * candidate). Prefer {@link resolveRelayServerCandidatesFromRequest} when a key
 * is available so per-environment hosts can fall back to their `-api` engine.
 */
export function resolveRelayServerUrlFromHost(
  host: string | null | undefined
): string {
  return resolveRelayServerCandidatesFromHost(host)[0]!;
}

export function resolveRelayServerUrlFromRequest(
  request: NextRequest | Request
): string {
  return resolveRelayServerCandidatesFromRequest(request)[0]!;
}

/**
 * Restrict a remembered engine cookie to the candidates valid for the current
 * host before trusting it, so a stale or forged cookie cannot redirect probes
 * to an arbitrary origin (SSRF).
 */
export function pickRememberedEngine(
  value: string | null | undefined,
  candidates: string[]
): string | null {
  if (value && candidates.includes(value)) {
    return value;
  }
  return null;
}

export interface EngineSelection {
  /** The engine that accepted the key, or null if none did. */
  baseUrl: string | null;
  /** True if at least one candidate responded (even to reject the key). */
  reachedAny: boolean;
  /** True if at least one candidate definitively rejected the key. */
  rejectedAny: boolean;
  /** True if at least one candidate could not definitively validate the key. */
  inconclusiveAny: boolean;
}

/**
 * Probe the candidate engines in order and return the first whose
 * `/v1/workspace` accepts the workspace key. Auth failures (401/403) are
 * conclusive rejections; network failures and other statuses are inconclusive.
 */
export async function selectEngineForKey(
  candidates: string[],
  apiKey: string
): Promise<EngineSelection> {
  let reachedAny = false;
  let rejectedAny = false;
  let inconclusiveAny = false;
  for (const baseUrl of candidates) {
    try {
      const url = new URL('/v1/workspace', baseUrl);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: 'no-store',
      });
      reachedAny = true;
      if (res.ok) {
        return { baseUrl, reachedAny, rejectedAny, inconclusiveAny };
      }
      if (res.status === 401 || res.status === 403) {
        rejectedAny = true;
      } else {
        inconclusiveAny = true;
      }
    } catch {
      inconclusiveAny = true;
      // Unreachable engine — fall through to the next candidate.
    }
  }
  return { baseUrl: null, reachedAny, rejectedAny, inconclusiveAny };
}

/**
 * Order candidates so a previously resolved engine is tried first, avoiding a
 * redundant probe of the other engine on every session/check call.
 */
export function orderByRemembered(
  candidates: string[],
  remembered: string | null
): string[] {
  if (!remembered) return candidates;
  return [remembered, ...candidates.filter((c) => c !== remembered)];
}
