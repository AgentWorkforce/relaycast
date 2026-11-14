import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle as sqliteDrizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPostgresConfig, type PostgresConfig } from '../config.js';

// setupFiles binds the process to 'sqlite'; each test imports a fresh,
// unbound module graph so the PostgreSQL handle can bind 'pg'.
const fresh = async () => ({
  handle: await import('../engineDb.js'),
  tables: await import('../../../db/tables.js'),
  ports: await import('../../../ports/database.js'),
  secretEnv: await import('../../../bin/secretEnv.js'),
});

const CA_FILE = fileURLToPath(new URL('./fixtures/test-ca.pem', import.meta.url));
const PASSWORD = 'not-a-real-password-9f3c';

function config(mode: 'owner' | 'runtime', port = 1): PostgresConfig {
  return loadPostgresConfig(
    {
      RELAYCAST_DATABASE_URL: `postgres://relaycast_${mode}:${PASSWORD}@127.0.0.1:${port}/app?sslmode=verify-full`,
      RELAYCAST_DATABASE_CA_FILE: CA_FILE,
    },
    mode,
  );
}

describe('PostgreSQL engine handle (no database)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('brands a drizzle PostgreSQL database as pg and binds the pg tables', async () => {
    const { handle, tables } = await fresh();
    const db = handle.brandPgEngineDb(pgDrizzle.mock());
    expect(db.engineDialect).toBe('pg');
    expect(Object.keys(db)).not.toContain('engineDialect');
    expect(handle.brandPgEngineDb(db)).toBe(db);
    expect(tables.currentSchemaDialect()).toBe('pg');
  });

  it('refuses a SQLite database and a handle branded sqlite', async () => {
    const { handle, tables } = await fresh();
    const sqlite = sqliteDrizzle(new Database(':memory:'));
    expect(() => handle.brandPgEngineDb(sqlite)).toThrow(/not a drizzle PostgreSQL database/);
    expect(() => handle.brandPgEngineDb({ dialect: {} })).toThrow(/not a drizzle PostgreSQL database/);
    expect(tables.currentSchemaDialect()).toBeUndefined();
    const fake = pgDrizzle.mock();
    Object.defineProperty(fake, 'engineDialect', { value: 'sqlite' });
    expect(() => handle.brandPgEngineDb(fake)).toThrow(/already branded "sqlite"/);
  });

  it('refuses to brand pg in a process bound to sqlite', async () => {
    const { handle, tables } = await fresh();
    tables.bindSchema('sqlite');
    expect(() => handle.brandPgEngineDb(pgDrizzle.mock())).toThrow(/already bound to 'sqlite'/);
  });

  it('exposes the transaction capability and schema-qualified SQL', async () => {
    const { handle, tables, ports } = await fresh();
    const pool = new pg.Pool({ max: 1 });
    try {
      const db = handle.buildPostgresEngineDb(pool);
      expect(ports.hasTransactionCapability(db)).toBe(true);
      expect(db.engineDialect).toBe('pg');
      const { sql } = db.select({ id: tables.workspaces.id }).from(tables.workspaces).toSQL();
      expect(sql).toBe('select "id" from "workspaces"');
      const other = tables.alias(tables.workspaces, 'other_workspace');
      expect(db.select({ id: other.id }).from(other).toSQL().sql).toBe(
        'select "id" from "workspaces" "other_workspace"',
      );
    } finally {
      await pool.end();
    }
  });

  it('refuses an owner config before connecting', async () => {
    const { handle, secretEnv } = await fresh();
    await expect(handle.openPostgresEngineDb(config('owner'))).rejects.toBeInstanceOf(secretEnv.ConfigError);
  });

  it('fails closed with a typed error when the database is unreachable, without credentials', async () => {
    const { handle, tables } = await fresh();
    const err = await handle.openPostgresEngineDb(config('runtime', 1)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(handle.PostgresUnavailableError);
    expect(String((err as Error).message)).not.toContain(PASSWORD);
    expect(tables.currentSchemaDialect()).toBeUndefined();
  });
});
