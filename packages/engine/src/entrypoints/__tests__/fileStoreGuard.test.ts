import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../node.js';

/** S3 file storage is a PostgreSQL-server feature: the SQLite server refuses it instead of silently using disk. */
describe('SQLite server and RELAYCAST_FILE_STORE', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('RELAYCAST_FILE_')) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it.each([
    [{ RELAYCAST_FILE_STORE: 's3' }],
    [{ RELAYCAST_FILE_S3_BUCKET: 'some-bucket' }],
  ])('refuses %o before opening anything', (env) => {
    Object.assign(process.env, env);
    let error: unknown;
    try { startServer({ dbPath: ':memory:', port: 0 }); } catch (e) { error = e; }
    expect((error as Error)?.name).toBe('ConfigError');
    expect((error as Error).message).toMatch(/only on the PostgreSQL backend/);
  });
});
