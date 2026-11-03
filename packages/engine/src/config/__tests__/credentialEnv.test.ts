import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../bin/secretEnv.js';
import { createCredentialTagSigner } from '../../auth/credentialTags.js';
import { credentialConfigFromEnv } from '../credentialEnv.js';
import { generateWorkspaceId } from '../../gateway.js';

const KEYRING = JSON.stringify({ current: 'a', keys: { a: 'env-test-tag-secret-a' } });
const WS = generateWorkspaceId();

describe('credentialConfigFromEnv', () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('ignores a half-set or invalid RelayAuth pair when a keyring is set', async () => {
    const config = credentialConfigFromEnv({
      RELAYCAST_CREDENTIAL_FORMAT: 'ar',
      RELAYCAST_CREDENTIAL_KEYRING: KEYRING,
      RELAYCAST_RELAYAUTH_URL: 'not a url',
    });
    expect(await config.credentialTagger!.tag(WS)).toMatch(/^a[0-9A-Za-z]{10}$/);
  });

  it('falls back to a remote tagger from the RelayAuth envs, and reads the token from _FILE', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, data: { tags: ['aAAA111bbb2'] } }));
    vi.stubGlobal('fetch', fetch);
    const config = credentialConfigFromEnv({
      RELAYCAST_CREDENTIAL_FORMAT: 'ar',
      RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid',
      RELAYCAST_RELAYAUTH_TOKEN_FILE: file(' relayauth-token \n'),
    });
    expect(await config.credentialTagger!.tag(WS)).toBe('aAAA111bbb2');
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer relayauth-token');
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(/^https:\/\/relayauth\.invalid\/v1\/relaycast\/credential-tags\/[0-9A-Za-z]+$/);
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
    expect(() => credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_URL: 'https://relayauth.invalid' })).toThrow(ConfigError);
    expect(() => credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_TOKEN: 'token' })).toThrow(ConfigError);
    expect(() =>
      credentialConfigFromEnv({ RELAYCAST_RELAYAUTH_URL: 'not a url', RELAYCAST_RELAYAUTH_TOKEN: 'token' }),
    ).toThrow(ConfigError);
  });
});
