import { normalizeTelemetryOrigin, type TelemetryOrigin } from '@relaycast/types';

export type OriginInfo = Partial<TelemetryOrigin>;

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
