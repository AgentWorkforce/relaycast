import type { Context, MiddlewareHandler } from 'hono';
import { parseCredential } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { emitServerEvent } from './serverTelemetry.js';
import { acceptsOnlyAr } from '../auth/credentials.js';

/** Where the legacy-credential deprecation is documented (the `Link` header on legacy responses). */
export const LEGACY_CREDENTIAL_DOCS_URL = 'https://github.com/AgentWorkforce/relaycast#credential-upgrade';

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
 * Deprecate the final response of a request a legacy credential authenticated,
 * whatever its status: `Deprecation: true`, `Sunset` when
 * `EngineConfig.legacyCredentialSunset` is set, and a `Link` to the upgrade
 * docs. A deployment that accepts only `ar_` credentials sends none.
 */
export const legacyCredentialHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.get('authenticatedCredentialFamily') !== 'legacy' || acceptsOnlyAr(c.get('db'))) return;
  const sunset = c.get('engine').config.legacyCredentialSunset;
  try {
    c.res.headers.set('Deprecation', 'true');
    if (sunset) c.res.headers.set('Sunset', sunset.toUTCString());
    c.res.headers.append('Link', `<${LEGACY_CREDENTIAL_DOCS_URL}>; rel="deprecation"`);
  } catch {
    // A runtime's WebSocket upgrade response can have immutable headers; the
    // connect is still reported through `request.authenticated`.
  }
};
