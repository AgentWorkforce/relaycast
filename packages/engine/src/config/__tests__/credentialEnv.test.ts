import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../bin/secretEnv.js';
import { createCredentialTagSigner } from '../../auth/credentialTags.js';
import { credentialConfigFromEnv } from '../credentialEnv.js';
import { generateWorkspaceId } from '../../gateway.js';

const KEYRING = JSON.stringify({ current: 'a', keys: { a: 'env-test-tag-secret-a' } });
const WS = generateWorkspaceId();

describe('credentialConfigFromEnv', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const file = (content: string): string => {
    dir ??= mkdtempSync(join(tmpdir(), 'relaycast-credential-env-'));
    const path = join(dir, `secret-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };

  it('builds a local signer from the keyring', async () => {
    const config = credentialConfigFromEnv({ RELAYCAST_CREDENTIAL_FORMAT: 'ar', RELAYCAST_CREDENTIAL_KEYRING: KEYRING });
    expect(config.credentialFormat).toBe('ar');
    expect(await config.credentialTagger!.tag(WS)).toBe(
      await createCredentialTagSigner({ current: 'a', keys: { a: 'env-test-tag-secret-a' } }).tag(WS),
    );
  });

  it('prefers an explicit keyring over RelayAuth', async () => {
    const config = credentialConfigFromEnv({
      RELAYCAST_CREDENTIAL_FORMAT: 'ar',
      RELAYCAST_CREDENTIAL_KEYRING: KEYRING,
      RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid',
      RELAYCAST_RELAYAUTH_TOKEN: 'token',
    });
    // A remote tagger would reach for the network here; the local signer answers.
    expect(await config.credentialTagger!.tag(WS)).toMatch(/^a[0-9A-Za-z]{10}$/);
  });

  it('falls back to a remote tagger from the RelayAuth envs, and reads the token from _FILE', async () => {
    const config = credentialConfigFromEnv({
      RELAYCAST_CREDENTIAL_FORMAT: 'ar',
      RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid',
      RELAYCAST_RELAYAUTH_TOKEN_FILE: file(' relayauth-token \n'),
    });
    expect(config.credentialTagger).toBeDefined();
    // The remote tagger reaches RelayAuth on use; an unreachable host fails.
    await expect(config.credentialTagger!.tag(WS)).rejects.toThrow();
  });

  it('enables the remote tagger under the legacy format too (credential upgrade)', () => {
    const config = credentialConfigFromEnv({
      RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid',
      RELAYCAST_RELAYAUTH_TOKEN: 'token',
    });
    expect(config.credentialFormat).toBe('legacy');
    expect(config.credentialTagger).toBeDefined();
  });

  it('refuses ar without a tagger source and refuses a half-set RelayAuth pair', () => {
    expect(() => credentialConfigFromEnv({ RELAYCAST_CREDENTIAL_FORMAT: 'ar' })).toThrow(ConfigError);
    expect(() => credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid' })).toThrow(
      'RELAYCAST_RELAYAUTH_URL is set without RELAYCAST_RELAYAUTH_TOKEN(_FILE)',
    );
    expect(() => credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_TOKEN: 'token' })).toThrow(
      'RELAYCAST_RELAYAUTH_TOKEN(_FILE) is set without RELAYCAST_RELAYAUTH_URL',
    );
    expect(() => credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_TOKEN_FILE: file('token') })).toThrow(ConfigError);
    expect(() =>
      credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_URL: 'not a url', RELAYCAST_RELAYAUTH_TOKEN: 'token' }),
    ).toThrow(ConfigError);
  });

  it('refuses a half-set RelayAuth pair beside a keyring, naming the keyring it would have used', () => {
    let thrown: unknown;
    try {
      credentialConfigFromEnv({ RELAYCAST_CREDENTIAL_KEYRING: KEYRING, RELAYCAST_RELAYAUTH_TOKEN: 'token' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toBe(
      'RELAYCAST_RELAYAUTH_TOKEN(_FILE) is set without RELAYCAST_RELAYAUTH_URL: '
      + 'RELAYCAST_RELAYAUTH_URL and RELAYCAST_RELAYAUTH_TOKEN(_FILE) are set together; '
      + 'RELAYCAST_CREDENTIAL_KEYRING is set and would have been used, so unset the RelayAuth variable or complete the pair',
    );
  });
});
