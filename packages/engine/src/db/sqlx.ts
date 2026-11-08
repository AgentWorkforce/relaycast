/**
 * Dialect-dispatched raw SQL execution.
 *
 * Engine code that runs hand-written SQL goes through these helpers rather than
 * calling a driver method directly: `db.all`/`db.run` exist only on drizzle's
 * SQLite databases, and PostgreSQL executes raw SQL with `execute()`. Each
 * helper switches on the handle's `engineDialect` brand (attached by the
 * adapter that built the handle) and throws for an unbranded or unknown
 * dialect -- there is no silent SQLite fallback.
 *
 * Statement text is still the caller's: SQLite-specific syntax in a query is
 * not translated here (later sqlx helpers cover the individual SQLite-isms).
 */
import type { SQL } from 'drizzle-orm';
import type { EngineDialect } from '../ports/engineDb.js';

/** The SQLite raw executors (drizzle `BaseSQLiteDatabase`; sync drivers return values, async ones promises). */
interface SqliteRawExecutor {
  all<T>(query: SQL): Promise<T[]> | T[];
  run(query: SQL): unknown;
}

/** The PostgreSQL raw executor (drizzle `PgDatabase.execute`, node-postgres result shape). */
interface PgRawExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/** Read the dialect brand of a handle, failing closed when it is missing or unknown. */
export function engineDialectOf(db: object): EngineDialect {
  const dialect = (db as { engineDialect?: unknown }).engineDialect;
  if (dialect === 'sqlite' || dialect === 'pg') return dialect;
  throw new Error(
    `Database handle has no supported engineDialect brand (got ${JSON.stringify(dialect) ?? 'undefined'}); ` +
      'the adapter that builds the handle must brand it (see brandSqliteEngineDb)',
  );
}

/** Run `query` and return every result row (column-name keyed objects). */
export async function all<T = unknown>(db: object, query: SQL): Promise<T[]> {
  const dialect = engineDialectOf(db);
  switch (dialect) {
    case 'sqlite':
      return await (db as SqliteRawExecutor).all<T>(query);
    case 'pg': {
      const result = await (db as PgRawExecutor).execute(query);
      if (!result || !Array.isArray(result.rows)) {
        throw new Error('PostgreSQL execute() returned no rows array; expected a node-postgres style result');
      }
      return result.rows as T[];
    }
    default:
      return unsupported(dialect);
  }
}

/** Run `query` for its effect; the driver's run result is not exposed. */
export async function run(db: object, query: SQL): Promise<void> {
  const dialect = engineDialectOf(db);
  switch (dialect) {
    case 'sqlite':
      await (db as SqliteRawExecutor).run(query);
      return;
    case 'pg':
      await (db as PgRawExecutor).execute(query);
      return;
    default:
      return unsupported(dialect);
  }
}

function unsupported(dialect: never): never {
  throw new Error(`Unsupported engine dialect: ${String(dialect)}`);
}
