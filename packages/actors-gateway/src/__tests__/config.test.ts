import { describe, expect, it } from 'vitest';
import { CONFIG_EXIT_CODE, ConfigError, loadConfig, secretFromEnv } from '../config.js';
import { KEYRING, baseEnv } from './harness.js';

const URL = 'http://127.0.0.1:7100';

function refusal(env: Record<string, string | undefined>, readFile?: (path: string) => string): ConfigError {
  try {
    loadConfig(env, readFile);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('configuration', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(baseEnv(URL));
    expect(config).toMatchObject({
      port: 8787,
      controlPlaneUrl: URL,
      projectId: 'local',
      controlPlaneSecret: undefined,
      homeRegion: undefined,
      publicWorkspaceCreate: true,
      workspaceBootstrapSecret: undefined,
      workspaceBootstrapProofRequired: false,
      fileStore: 'local',
      fileDir: '/data/files',
      maxUploadBytes: 64 * 1024 * 1024,
      actorInvokeTimeoutMs: 60_000,
      actorCreateTimeoutMs: 180_000,
      shutdownGraceMs: 10_000,
      logFormat: 'json',
      environment: 'production',
      internalSecret: undefined,
      credentialKeyring: KEYRING,
    });
  });

  it('reads every setting and normalizes the control plane URL to its origin', () => {
    const config = loadConfig(baseEnv('https://actors.example.com/', {
      PORT: '9000',
      DURABLE_ACTORS_PROJECT_ID: 'proj_1',
      DURABLE_ACTORS_SECRET: 'da-secret',
      DURABLE_ACTORS_HOME_REGION: 'eu-west',
      RELAYCAST_INTERNAL_SECRET: 'x'.repeat(32),
      RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'false',
      RELAYCAST_FILE_STORE: 's3',
      RELAYCAST_FILE_DIR: '/var/files',
      RELAYCAST_MAX_UPLOAD_BYTES: '1024',
      RELAYCAST_ACTOR_INVOKE_TIMEOUT_MS: '5000',
      RELAYCAST_ACTOR_CREATE_TIMEOUT_MS: '300000',
      RELAYCAST_SHUTDOWN_GRACE_MS: '0',
      RELAYCAST_LOG_FORMAT: 'text',
      RELAYCAST_ENV: 'staging',
    }));
    expect(config).toMatchObject({
      port: 9000,
      controlPlaneUrl: 'https://actors.example.com',
      projectId: 'proj_1',
      controlPlaneSecret: 'da-secret',
      homeRegion: 'eu-west',
      internalSecret: 'x'.repeat(32),
      publicWorkspaceCreate: false,
      fileStore: 's3',
      fileDir: '/var/files',
      maxUploadBytes: 1024,
      actorInvokeTimeoutMs: 5000,
      actorCreateTimeoutMs: 300_000,
      shutdownGraceMs: 0,
      logFormat: 'text',
      environment: 'staging',
    });
    expect(loadConfig(baseEnv(URL, { DURABLE_ACTORS_API_KEY: 'alias' })).controlPlaneSecret).toBe('alias');
  });

  it('refuses missing or malformed settings with exit-64 errors that never echo secrets', () => {
    expect(CONFIG_EXIT_CODE).toBe(64);
    expect(refusal({ ...baseEnv(URL), DURABLE_ACTORS_CONTROL_PLANE_URL: undefined }).code).toBe('invalid_config');
    expect(refusal(baseEnv('ftp://x')).message).toMatch(/DURABLE_ACTORS_CONTROL_PLANE_URL/);
    expect(refusal(baseEnv(`${URL}/v1/projects/local/actors`)).message).toMatch(/origin/);
    expect(refusal({ ...baseEnv(URL), DURABLE_ACTORS_PROJECT_ID: undefined }).message).toMatch(/DURABLE_ACTORS_PROJECT_ID/);
    expect(refusal(baseEnv(URL, { DURABLE_ACTORS_PROJECT_ID: 'a/b' })).message).toMatch(/DURABLE_ACTORS_PROJECT_ID/);
    expect(refusal(baseEnv(URL, { RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'yes' })).message).toMatch(/RELAYCAST_PUBLIC_WORKSPACE_CREATE/);
    expect(refusal(baseEnv(URL, { RELAYCAST_FILE_STORE: 'disk' })).message).toMatch(/RELAYCAST_FILE_STORE/);
    expect(refusal(baseEnv(URL, { RELAYCAST_MAX_UPLOAD_BYTES: '0' })).message).toMatch(/RELAYCAST_MAX_UPLOAD_BYTES/);
    expect(refusal(baseEnv(URL, { RELAYCAST_SHUTDOWN_GRACE_MS: '-1' })).message).toMatch(/RELAYCAST_SHUTDOWN_GRACE_MS/);
    expect(refusal(baseEnv(URL, { RELAYCAST_LOG_FORMAT: 'pretty' })).message).toMatch(/RELAYCAST_LOG_FORMAT/);
    expect(refusal(baseEnv(URL, { PORT: '70000' })).message).toMatch(/PORT/);

    const noFileSecret = refusal({ ...baseEnv(URL), RELAYCAST_FILE_SIGNING_SECRET: '' });
    expect(noFileSecret.code).toBe('missing_file_signing_secret');
    const weakFileSecret = refusal(baseEnv(URL, { RELAYCAST_FILE_SIGNING_SECRET: 'dev-secret' }));
    expect(weakFileSecret.code).toBe('weak_file_signing_secret');
    expect(weakFileSecret.message).not.toContain('dev-secret');
    expect(refusal({ ...baseEnv(URL), RELAYCAST_CREDENTIAL_KEYRING: undefined }).code).toBe('missing_credential_keyring');
    const badRing = refusal(baseEnv(URL, { RELAYCAST_CREDENTIAL_KEYRING: JSON.stringify({ current: 'a', keys: { a: 'short' } }) }));
    expect(badRing.code).toBe('invalid_credential_keyring');
    expect(badRing.message).not.toContain('short');
    const weak = refusal(baseEnv(URL, { RELAYCAST_INTERNAL_SECRET: 'weak-secret' }));
    expect(weak.code).toBe('weak_internal_secret');
    expect(weak.message).not.toContain('weak-secret');
  });

  it('carries the object-store settings it was given, not process.env', () => {
    const ambient = process.env.RELAYCAST_S3_BUCKET;
    process.env.RELAYCAST_S3_BUCKET = 'ambient';
    try {
      const config = loadConfig(baseEnv(URL, { RELAYCAST_FILE_STORE: 's3', RELAYCAST_S3_BUCKET: 'given', RELAYCAST_S3_ENDPOINT: 'http://minio:9000', RELAYCAST_GCS_PREFIX: 'p' }));
      expect(config.fileStoreEnv).toEqual({ RELAYCAST_S3_BUCKET: 'given', RELAYCAST_S3_ENDPOINT: 'http://minio:9000', RELAYCAST_GCS_PREFIX: 'p' });
      expect(loadConfig(baseEnv(URL)).fileStoreEnv).toEqual({});
    } finally {
      if (ambient === undefined) delete process.env.RELAYCAST_S3_BUCKET;
      else process.env.RELAYCAST_S3_BUCKET = ambient;
    }
  });

  it('reads the workspace bootstrap secret verbatim (its bytes feed a derivation)', () => {
    expect(loadConfig(baseEnv(URL)).workspaceBootstrapSecret).toBeUndefined();
    expect(loadConfig(baseEnv(URL, { RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: ' exact bytes ' })).workspaceBootstrapSecret).toBe(' exact bytes ');
    expect(loadConfig({ ...baseEnv(URL), RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: '/secrets/bootstrap' }, () => 'from-file\n').workspaceBootstrapSecret).toBe('from-file');
  });

  it('reads the bootstrap proof flag from its raw value, exactly "true" or "false", as the actor does', () => {
    const secret = { RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef' };
    expect(loadConfig(baseEnv(URL, secret)).workspaceBootstrapProofRequired).toBe(false);
    expect(loadConfig(baseEnv(URL, { ...secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'false' })).workspaceBootstrapProofRequired).toBe(false);
    expect(loadConfig(baseEnv(URL, { ...secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' })).workspaceBootstrapProofRequired).toBe(true);
    // Blank is unset.
    expect(loadConfig(baseEnv(URL, { ...secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: '' })).workspaceBootstrapProofRequired).toBe(false);
    expect(loadConfig(baseEnv(URL, { ...secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: '  ' })).workspaceBootstrapProofRequired).toBe(false);
    // Not trimmed: the actor refuses "true ", so the gateway does too, rather than start a stack the actors will not.
    for (const value of ['yes', '1', 'TRUE', 'required', 'true ', ' false']) {
      const refused = refusal(baseEnv(URL, { ...secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: value }));
      expect(refused.code).toBe('invalid_config');
      expect(refused.message).toMatch(/RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED/);
    }
    // Like the engine's server, the flag without a secret starts: a keyed create then fails closed (503) before any proof is asked.
    expect(loadConfig(baseEnv(URL, { RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' }))).toMatchObject({ workspaceBootstrapSecret: undefined, workspaceBootstrapProofRequired: true });
  });

  it('reads secrets from _FILE variants and refuses unreadable files', () => {
    const files: Record<string, string> = { '/run/secrets/internal': `${'s'.repeat(40)}\n`, '/run/secrets/ring': JSON.stringify(KEYRING) };
    const readFile = (path: string): string => {
      if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[path];
    };
    const config = loadConfig({
      ...baseEnv(URL),
      RELAYCAST_CREDENTIAL_KEYRING: undefined,
      RELAYCAST_CREDENTIAL_KEYRING_FILE: '/run/secrets/ring',
      RELAYCAST_INTERNAL_SECRET_FILE: '/run/secrets/internal',
    }, readFile);
    expect(config.internalSecret).toBe('s'.repeat(40));
    expect(config.credentialKeyring).toEqual(KEYRING);

    const unreadable = refusal(baseEnv(URL, { RELAYCAST_INTERNAL_SECRET_FILE: '/run/secrets/missing' }), readFile);
    expect(unreadable.code).toBe('unreadable_secret_file');
    expect(unreadable.message).toContain('RELAYCAST_INTERNAL_SECRET_FILE');
    expect(unreadable.message).toContain('ENOENT');

    // A directly set variable wins over its _FILE variant; blank means unset.
    expect(secretFromEnv({ X: ' direct ', X_FILE: '/run/secrets/internal' }, 'X', readFile)).toBe('direct');
    expect(secretFromEnv({ X: '', X_FILE: '/run/secrets/internal' }, 'X', readFile)).toBe('s'.repeat(40));
    expect(secretFromEnv({ X: '   ' }, 'X', readFile)).toBeUndefined();
  });
});
