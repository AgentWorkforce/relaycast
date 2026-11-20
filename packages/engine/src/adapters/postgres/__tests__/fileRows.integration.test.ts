/**
 * The files migration's row read (relaycast#669 follow-up) against the real
 * PostgreSQL fixture: paged by id, deleted rows excluded. Skipped unless
 * RELAYCAST_PG_TEST_URL_OWNER, _URL_RUNTIME and RELAYCAST_PG_TEST_CA_FILE are
 * set (see postgres.integration.test.ts). Holds the fixture lock for its whole
 * run; resets and migrates the schema as the owner, so it does not depend on
 * another file having migrated first. Inserts its rows as the runtime role.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPostgresConfig } from '../config.js';
import { loadBundledPostgresMigrations, runPostgresMigrations } from '../migrate.js';
import { openPostgresPool } from '../pool.js';
import { holdFixtureLock, resetSchema, SCHEMA } from './fixture.js';

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

describe.skipIf(!enabled)('migrate-files-to-s3 file rows (integration)', { timeout: 60_000 }, () => {
  const ws = `wsrows${Date.now()}`;
  let owner: pg.Pool | undefined;
  let releaseFixture: (() => Promise<void>) | undefined;
  let client: pg.Client;

  beforeAll(async () => {
    owner = openPostgresPool(loadPostgresConfig(
      { RELAYCAST_DATABASE_URL: OWNER_URL, RELAYCAST_DATABASE_CA_FILE: CA_FILE },
      'owner',
    ));
    // Waits for the fixture lock while other PostgreSQL test files hold it.
    releaseFixture = await holdFixtureLock(owner);
    await resetSchema(owner);
    await runPostgresMigrations(owner, {
      schema: SCHEMA,
      bundled: loadBundledPostgresMigrations(),
      runtimeRole: 'relaycast_runtime',
    });
  }, 180_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    // Only the lock holder may reset: a beforeAll that timed out waiting must
    // not drop the schema under the file that holds it.
    if (owner && releaseFixture) await resetSchema(owner).catch(() => {});
    await releaseFixture?.().catch(() => {});
    await owner?.end().catch(() => {});
  });

  it('reads every live row across pages and leaves deleted ones out', async () => {
    const url = new URL(RUNTIME_URL!);
    client = new pg.Client({
      host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1),
      ssl: { ca: readFileSync(CA_FILE!, 'utf8'), rejectUnauthorized: true },
    });
    await client.connect();
    await client.query('INSERT INTO workspaces (id, name, api_key_hash) VALUES ($1, $1, $1)', [ws]);
    await client.query('INSERT INTO agents (id, workspace_id, name, token_hash) VALUES ($1, $2, $1, $1)', [`${ws}-a`, ws]);
    // 2,500 live rows (three pages of 1,000) plus 10 deleted ones.
    await client.query(`
      INSERT INTO files (id, workspace_id, uploaded_by, filename, content_type, size_bytes, storage_key, status)
      SELECT $1 || '-' || lpad(n::text, 5, '0'), $1, $2, 'f.txt', 'text/plain', n, $1 || '/f' || n || '/f' || n || '.txt',
             CASE WHEN n > 2500 THEN 'deleted' WHEN n % 2 = 0 THEN 'complete' ELSE 'pending' END
      FROM generate_series(1, 2510) AS n`, [ws, `${ws}-a`]);

    // setupFiles binds this process to 'sqlite'; load a fresh module graph the
    // PostgreSQL handle can bind to 'pg'.
    vi.resetModules();
    const { loadFileRowsFromPostgres } = await import('../../../entrypoints/node.js');
    const rows = (await loadFileRowsFromPostgres({ RELAYCAST_DATABASE_URL: RUNTIME_URL, RELAYCAST_DATABASE_CA_FILE: CA_FILE }))
      .filter((row) => row.storageKey.startsWith(`${ws}/`));
    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((row) => row.storageKey)).size).toBe(2500);
    expect(rows.every((row) => row.status !== 'deleted')).toBe(true);
    expect(rows.find((row) => row.storageKey === `${ws}/f2/f2.txt`)).toEqual({ storageKey: `${ws}/f2/f2.txt`, status: 'complete', sizeBytes: 2 });
  });
});

const S3_ENDPOINT = process.env.RELAYCAST_S3_TEST_ENDPOINT;
const S3_BUCKET = process.env.RELAYCAST_S3_TEST_BUCKET;

describe.skipIf(!(enabled && OWNER_URL && S3_ENDPOINT && S3_BUCKET))('migrate-files-to-s3 database identity (integration)', { timeout: 60_000 }, () => {
  it('exits 65, as the server does, when the database credentials are not the runtime identity', async () => {
    vi.resetModules();
    const { runMigrateFilesToS3Command } = await import('../../../entrypoints/node.js');
    const lines: string[] = [];
    const code = await runMigrateFilesToS3Command(['--from', '/nonexistent'], {
      RELAYCAST_DATABASE_URL: OWNER_URL,
      RELAYCAST_DATABASE_CA_FILE: CA_FILE,
      RELAYCAST_FILE_STORE: 's3',
      RELAYCAST_FILE_S3_BUCKET: S3_BUCKET,
      RELAYCAST_FILE_S3_REGION: process.env.RELAYCAST_S3_TEST_REGION ?? 'us-east-1',
      RELAYCAST_FILE_S3_ENDPOINT: S3_ENDPOINT,
      RELAYCAST_FILE_S3_FORCE_PATH_STYLE: 'true',
    }, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    expect(code).toBe(65);
    // Credentials never reach the output.
    const password = decodeURIComponent(new URL(OWNER_URL!).password);
    expect(lines.join('\n')).not.toContain(password);
  });
});
