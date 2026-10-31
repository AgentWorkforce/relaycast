import type { Context } from 'hono';
import { parseCredential } from '@relaycast/types';
import type { AppEnv } from '../env.js';
import { emitServerEvent } from './serverTelemetry.js';
import { acceptsOnlyAr } from '../auth/credentials.js';

/** Where the legacy-credential deprecation is documented (the `Link` header on legacy responses). */
export const LEGACY_CREDENTIAL_DOCS_URL = 'https://github.com/AgentWorkforce/relaycast#credential-upgrade';

/**
 * Note the credential that authenticated this request. Every authenticated
 * request reports `request.authenticated` with the credential's family and
 * kind (the observation carries the workspace and the origin client and
 * version). A response to a legacy credential is marked deprecated: `Deprecation:
 * true`, `Sunset` when `EngineConfig.legacyCredentialSunset` is set, and a
 * `Link` to the upgrade docs. Call it after `next()`, so the headers land on
 * the response the route produced.
 */
export function noteAuthenticatedCredential(c: Context<AppEnv>, token: string, workspaceId: string): void {
  const parsed = parseCredential(token);
  if (!parsed) return;
  if (parsed.family === 'legacy' && !acceptsOnlyAr(c.get('db'))) {
    c.header('Deprecation', 'true');
    const sunset = c.get('engine').config.legacyCredentialSunset;
    if (sunset) c.header('Sunset', sunset.toUTCString());
    c.header('Link', `<${LEGACY_CREDENTIAL_DOCS_URL}>; rel="deprecation"`, { append: true });
  }
  emitServerEvent(c, workspaceId, 'request.authenticated', {
    credential_family: parsed.family,
    credential_kind: parsed.kind,
  });
}
