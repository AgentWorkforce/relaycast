import { ConfigError, secretFromEnv } from '../bin/secretEnv.js';
import { createCredentialTagSigner, parseCredentialKeyring } from '../auth/credentialTags.js';
import type { EngineConfig } from '../ports/index.js';

export type CredentialEnvConfig = Pick<
  EngineConfig,
  'credentialFormat' | 'credentialTagger' | 'legacyCredentialGraceSeconds' | 'legacyCredentialSunset'
>;

/**
 * The credential settings of a self-hosted engine, from its environment. The
 * `relaycast-engine` binary and the container entrypoint both read them here:
 *
 * - `RELAYCAST_CREDENTIAL_KEYRING(_FILE)`: `{"current":"a","keys":{"a":"<secret>"}}`,
 *   the keyring that signs `ar_` credential tags (enables
 *   `POST /v1/credentials/upgrade`);
 * - `RELAYCAST_CREDENTIAL_FORMAT`: `legacy` (default) or `ar` (needs the keyring);
 * - `RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS`: how long an upgraded legacy
 *   credential keeps working (default 30 days);
 * - `RELAYCAST_LEGACY_CREDENTIAL_SUNSET`: an ISO-8601 date sent as `Sunset` on
 *   legacy-authenticated responses.
 *
 * Throws {@link ConfigError} for a value the engine would refuse.
 */
export function credentialConfigFromEnv(env: NodeJS.ProcessEnv): CredentialEnvConfig {
  const keyring = secretFromEnv(env, 'RELAYCAST_CREDENTIAL_KEYRING');
  const format = env.RELAYCAST_CREDENTIAL_FORMAT?.trim() || 'legacy';
  if (format !== 'legacy' && format !== 'ar') {
    throw new ConfigError('RELAYCAST_CREDENTIAL_FORMAT must be "legacy" or "ar"');
  }
  if (format === 'ar' && !keyring) {
    throw new ConfigError('RELAYCAST_CREDENTIAL_FORMAT=ar needs RELAYCAST_CREDENTIAL_KEYRING');
  }
  let credentialTagger: EngineConfig['credentialTagger'];
  if (keyring) {
    try {
      credentialTagger = createCredentialTagSigner(parseCredentialKeyring(keyring));
    } catch (error) {
      throw new ConfigError(`RELAYCAST_CREDENTIAL_KEYRING: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const grace = env.RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS?.trim();
  if (grace && !/^\d+$/.test(grace)) {
    throw new ConfigError('RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS must be a non-negative integer');
  }
  const sunsetText = env.RELAYCAST_LEGACY_CREDENTIAL_SUNSET?.trim();
  const sunset = sunsetText ? new Date(sunsetText) : undefined;
  if (sunset && Number.isNaN(sunset.getTime())) {
    throw new ConfigError('RELAYCAST_LEGACY_CREDENTIAL_SUNSET must be an ISO-8601 date');
  }
  return {
    credentialFormat: format,
    ...(credentialTagger ? { credentialTagger } : {}),
    ...(grace ? { legacyCredentialGraceSeconds: Number(grace) } : {}),
    ...(sunset ? { legacyCredentialSunset: sunset } : {}),
  };
}
