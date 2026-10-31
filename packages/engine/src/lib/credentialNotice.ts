import type { Context, MiddlewareHandler } from 'hono';
import { parseCredential } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { emitServerEvent } from './serverTelemetry.js';
import { acceptsOnlyAr } from '../auth/credentials.js';
import type { TelemetrySink } from '../ports/telemetry.js';
import { extractOriginActor, requiredOriginInfo } from './origin.js';

/** Where the legacy-credential deprecation is documented (the `Link` header on legacy responses). */
export const LEGACY_CREDENTIAL_DOCS_URL = 'https://github.com/AgentWorkforce/relaycast#credential-upgrade';

/** When the legacy credential family was deprecated: 2026-10-30T00:00:00Z. */
export const LEGACY_CREDENTIALS_DEPRECATED_AT = new Date(Date.UTC(2026, 9, 30));

/** The RFC 9745 `Deprecation` value: a structured-field Date (`@<unix seconds>`). */
export const LEGACY_CREDENTIAL_DEPRECATION = `@${Math.floor(LEGACY_CREDENTIALS_DEPRECATED_AT.getTime() / 1000)}`;

/**
 * Note the credential that authenticated this request, at authentication time
 * and whatever the request then does. It reports `request.authenticated` with
 * the credential's family and kind (the observation carries the workspace and
 * the origin client and version), once per request. A legacy credential marks
 * the request so {@link legacyCredentialHeaders} deprecates its final response.
 */
export function noteAuthenticatedCredential(c: Context<AppEnv>, token: string, workspaceId: string): void {
  const parsed = parseCredential(token);
  if (!parsed || c.get('authenticatedCredentialFamily')) return;
  c.set('authenticatedCredentialFamily', parsed.family);
  emitServerEvent(c, workspaceId, 'request.authenticated', {
    credential_family: parsed.family,
    credential_kind: parsed.kind,
  });
}

/**
 * Report `request.authenticated` for a connect authenticated outside a Hono
 * context (the Node server's native WebSocket upgrade), with the same facts
 * and origin {@link noteAuthenticatedCredential} reports.
 */
export function observeAuthenticatedCredential(telemetry: TelemetrySink, request: Request, token: string, workspaceId: string): void {
  const parsed = parseCredential(token);
  if (!parsed) return;
  const origin = requiredOriginInfo(request);
  try {
    const pending = telemetry.capture({
      kind: 'request.authenticated',
      occurredAt: new Date().toISOString(),
      workspaceId,
      origin: { actor: extractOriginActor(request), client: origin.origin_client, version: origin.origin_version },
      facts: { credential_family: parsed.family, credential_kind: parsed.kind },
    });
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Host observation is best effort.
  }
}

/**
 * Deprecate the final response of a request a legacy credential authenticated,
 * whatever its status: `Deprecation` (RFC 9745, the date the legacy family
 * was deprecated), `Sunset` (RFC 8594, an HTTP-date) when
 * `EngineConfig.legacyCredentialSunset` is set, and
 * `Link: <docs>; rel="deprecation"`. A deployment that accepts only `ar_` credentials sends none.
 */
export const legacyCredentialHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.get('authenticatedCredentialFamily') !== 'legacy' || acceptsOnlyAr(c.get('db'))) return;
  const sunset = c.get('engine').config.legacyCredentialSunset;
  try {
    c.res.headers.set('Deprecation', LEGACY_CREDENTIAL_DEPRECATION);
    if (sunset) c.res.headers.set('Sunset', sunset.toUTCString());
    c.res.headers.append('Link', `<${LEGACY_CREDENTIAL_DOCS_URL}>; rel="deprecation"`);
  } catch {
    // A runtime's WebSocket upgrade response can have immutable headers; the
    // connect is still reported through `request.authenticated`.
  }
};
