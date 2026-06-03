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
 * The new hosted engine (`gateway.relaycast.dev`) is the happy path and comes
 * first; the legacy engine (`api.relaycast.dev`) runs alongside it for
 * workspaces that have not migrated and is used as a fallback. Callers probe the
 * candidates in order and keep the first one that accepts the workspace key.
 *
 * Examples:
 * - observer.relaycast.dev -> [gateway.relaycast.dev, api.relaycast.dev]
 * - pr23-observer.relaycast.dev -> [pr23-gateway.relaycast.dev, pr23-api.relaycast.dev]
 *
 * Per-environment gateway hostnames (`staging-gateway`, `prNN-gateway`) are
 * assumed to mirror the legacy `-api` naming. If a gateway host does not exist
 * for an environment, the probe simply fails over to its `-api` counterpart, so
 * the assumption carries no risk.
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

  if (normalized === 'observer.relaycast.dev') {
    return ['https://gateway.relaycast.dev', 'https://api.relaycast.dev'];
  }

  return ['https://gateway.relaycast.dev', 'https://api.relaycast.dev'];
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
 * is available so legacy workspaces can fall back to the `api` engine.
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
}

/**
 * Probe the candidate engines in order and return the first whose
 * `/v1/workspace` accepts the workspace key. A candidate that is unreachable
 * (network/DNS error) is skipped; one that responds with a non-OK status counts
 * as reached but not authenticated.
 */
export async function selectEngineForKey(
  candidates: string[],
  apiKey: string
): Promise<EngineSelection> {
  let reachedAny = false;
  for (const baseUrl of candidates) {
    try {
      const res = await fetch(`${baseUrl}/v1/workspace`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      reachedAny = true;
      if (res.ok) {
        return { baseUrl, reachedAny };
      }
    } catch {
      // Unreachable engine — fall through to the next candidate.
    }
  }
  return { baseUrl: null, reachedAny };
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
