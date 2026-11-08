import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Engine code reaches the database only through the neutral EngineDb and the
// table binding in db/tables.ts. SQLite-specific types and casts that hide a
// handle's dialect are allowed only in the SQLite schema, the binding, and
// the adapters.
const SRC = fileURLToPath(new URL('..', import.meta.url));
const SELF = relative(SRC, fileURLToPath(import.meta.url)).split(sep).join('/');
const ALLOWED = (path: string) =>
  path === 'db/schema.ts' || path === 'db/tables.ts' || path.startsWith('adapters/') || path === SELF;
// drizzle-orm/pg-core is for the Postgres schema, the binding, the dialect
// helpers (sqlx renders and detects PG fragments), the adapters, and the
// sqlx tests that compile PG text. Three tests read the PG table configs:
// the PG/SQLite schema parity test, the binding test (checks PgTable), and
// the database-error test (builds the unique-constraint map from the PG schema).
const PG_CORE_ALLOWED = (path: string) =>
  path === 'db/sqlx.ts' || path === 'db/schema.pg.ts' || path === 'db/tables.ts'
  || path.startsWith('adapters/') || path === SELF || /^(?:db\/)?__tests__\/sqlx[^/]*\.test\.ts$/.test(path)
  || path === 'db/__tests__/schema.pg.test.ts' || path === 'db/__tests__/tables.test.ts'
  || path === 'ports/__tests__/databaseErrors.test.ts';

// The PG/SQLite schema parity test reads both declarations' table configs
// (sqlite-core's getTableConfig/SQLiteTable beside pg-core's) to compare
// them column by column. It is the only non-adapter file that may import
// sqlite-core, and only for that comparison; it is still held to the cast rule.
const SQLITE_CORE_ALLOWED = (path: string) => ALLOWED(path) || path === 'db/__tests__/schema.pg.test.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function violations(pattern: RegExp, allowed: (path: string) => boolean = ALLOWED): string[] {
  const found: string[] = [];
  for (const file of sources(SRC)) {
    const path = relative(SRC, file).split(sep).join('/');
    if (allowed(path)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe('EngineDb boundary', () => {
  it('has no cast to EngineDb outside the adapters', () => {
    expect(violations(/\bas\s+(?:unknown\s+as\s+)?EngineDb\b/)).toEqual([]);
  });

  it('has no drizzle-orm/sqlite-core import outside the schema, binding and adapters', () => {
    expect(violations(/['"]drizzle-orm\/sqlite-core['"]/, SQLITE_CORE_ALLOWED)).toEqual([]);
  });

  it('has no drizzle-orm/pg-core import outside sqlx, the PG schema, binding, adapters and sqlx tests', () => {
    expect(violations(/['"]drizzle-orm\/pg-core['"]/, PG_CORE_ALLOWED)).toEqual([]);
  });

  it('scans the engine sources', () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
  });
});
