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
 * Resolve the Relay API base URL from observer host.
 *
 * Examples:
 * - observer.relaycast.dev -> https://api.relaycast.dev
 * - pr23-observer.relaycast.dev -> https://pr23-api.relaycast.dev
 */
export function resolveRelayServerUrlFromHost(host: string | null | undefined): string {
  const normalized = normalizeHost(host);

  if (!normalized || isLocalHost(normalized)) {
    return process.env.RELAY_SERVER_URL || 'http://localhost:3890';
  }

  // Accept both custom domains and workers/pages preview hostnames that begin with prNN-observer.
  const prMatch = normalized.match(/^pr(\d+)-observer(?:[.-]|$)/);
  if (prMatch) {
    return `https://pr${prMatch[1]}-api.relaycast.dev`;
  }

  if (normalized === 'staging-observer.relaycast.dev') {
    return 'https://staging-api.relaycast.dev';
  }

  if (normalized === 'observer.relaycast.dev') {
    return 'https://api.relaycast.dev';
  }

  return process.env.RELAY_SERVER_URL || 'https://api.relaycast.dev';
}

export function resolveRelayServerUrlFromRequest(request: NextRequest | Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = request.headers.get('host');
  return resolveRelayServerUrlFromHost(forwardedHost ?? host);
}
