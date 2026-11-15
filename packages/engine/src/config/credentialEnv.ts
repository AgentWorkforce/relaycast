import { ConfigError, secretFromEnv } from '../bin/secretEnv.js';
import { createCredentialTagSigner, parseCredentialKeyring } from '../auth/credentialTags.js';
import { remoteCredentialTagger } from '../auth/remoteCredentialTags.js';
import type { EngineConfig } from '../ports/index.js';
import { MAX_LEGACY_CREDENTIAL_GRACE_SECONDS } from '../engine/credentialUpgrade.js';

export type CredentialEnvConfig = Pick<
  EngineConfig,
  'credentialFormat' | 'credentialTagger' | 'legacyCredentialGraceSeconds' | 'legacyCredentialSunset'
>;

/** The remote tagger RelayAuth's envs describe, or undefined when neither is set. */
function relayauthTaggerFromEnv(env: NodeJS.ProcessEnv): EngineConfig['credentialTagger'] {
  const baseUrl = env.RELAYCAST_RELAYAUTH_URL?.trim();
  const token = secretFromEnv(env, 'RELAYCAST_RELAYAUTH_TOKEN');
  if (!baseUrl && !token) return undefined;
  if (!baseUrl || !token) {
    throw new ConfigError('RELAYCAST_RELAYAUTH_URL and RELAYCAST_RELAYAUTH_TOKEN(_FILE) are set together');
  }
  try {
    return remoteCredentialTagger({ baseUrl, token });
  } catch (error) {
    throw new ConfigError(`RELAYCAST_RELAYAUTH_URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The credential settings of a self-hosted engine, from its environment. The
 * `relaycast-engine` binary and the container entrypoint both read them here:
 *
 * - `RELAYCAST_CREDENTIAL_KEYRING(_FILE)`: `{"current":"a","keys":{"a":"<secret>"}}`,
 *   the keyring that signs `ar_` credential tags (enables
 *   `POST /v1/credentials/upgrade`);
 * - `RELAYCAST_RELAYAUTH_URL` + `RELAYCAST_RELAYAUTH_TOKEN(_FILE)`: take the
 *   tags from RelayAuth instead of a local keyring. An explicit keyring wins
 *   and RelayAuth settings are not read; either also satisfies
 *   `RELAYCAST_CREDENTIAL_FORMAT=ar` and enables `POST /v1/credentials/upgrade`;
 * - `RELAYCAST_CREDENTIAL_FORMAT`: `legacy` (default) or `ar` (needs a tagger);
 * - `RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS`: how long an upgraded legacy
 *   credential keeps working (default 30 days);
 * - `RELAYCAST_LEGACY_CREDENTIAL_SUNSET`: an ISO-8601 date sent as `Sunset` on
 *   legacy-authenticated responses.
 *
 * Throws {@link ConfigError} for a value the engine would refuse.
 */
export function credentialConfigFromEnv(env: NodeJS.ProcessEnv): CredentialEnvConfig {
  const keyring = secretFromEnv(env, 'RELAYCAST_CREDENTIAL_KEYRING');
  // An explicit keyring wins, so a leftover or half-set RelayAuth pair must not refuse startup.
  const relayauthTagger = keyring ? undefined : relayauthTaggerFromEnv(env);
  const format = env.RELAYCAST_CREDENTIAL_FORMAT?.trim() || 'legacy';
  if (format !== 'legacy' && format !== 'ar') {
    throw new ConfigError('RELAYCAST_CREDENTIAL_FORMAT must be "legacy" or "ar"');
  }
  if (format === 'ar' && !keyring && !relayauthTagger) {
    throw new ConfigError('RELAYCAST_CREDENTIAL_FORMAT=ar needs RELAYCAST_CREDENTIAL_KEYRING or RELAYCAST_RELAYAUTH_URL + RELAYCAST_RELAYAUTH_TOKEN(_FILE)');
  }
  let credentialTagger: EngineConfig['credentialTagger'];
  if (keyring) {
    try {
      credentialTagger = createCredentialTagSigner(parseCredentialKeyring(keyring));
    } catch (error) {
      throw new ConfigError(`RELAYCAST_CREDENTIAL_KEYRING: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    credentialTagger = relayauthTagger;
  }
  const grace = env.RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS?.trim();
  if (grace && !(/^\d+$/.test(grace) && Number(grace) <= MAX_LEGACY_CREDENTIAL_GRACE_SECONDS)) {
    throw new ConfigError(`RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS must be an integer from 0 to ${MAX_LEGACY_CREDENTIAL_GRACE_SECONDS}`);
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
