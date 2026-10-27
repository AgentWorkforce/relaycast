import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';

/**
 * The raw SQLite connection surface the Node adapter uses for migrations,
 * pragmas, transactions, and shutdown. It is better-sqlite3's `Database`;
 * another driver supplies a facade that implements the subset the engine
 * relies on (`exec`, `prepare`, `pragma`, `transaction`, `inTransaction`,
 * `open`, `close`).
 */
export type SqliteConnection = Database.Database;

/**
 * The seam between the Node adapter and a concrete synchronous SQLite driver.
 *
 * This module is the default (better-sqlite3). The standalone single-file
 * build replaces it at bundle time with a `bun:sqlite` implementation that
 * exports the same `sqliteDriver` binding (see `packages/engine/standalone/`),
 * so every engine code path stays shared.
 */
export interface SqliteDriver {
  /** Driver name, for diagnostics. */
  readonly name: string;
  /** Open (creating if absent) a database file, or `':memory:'`. */
  open(path: string): SqliteConnection;
  /** Build the synchronous Drizzle handle over the engine schema for `sqlite`. */
  drizzle(sqlite: SqliteConnection): unknown;
}

export const sqliteDriver: SqliteDriver = {
  name: 'better-sqlite3',
  open: (path) => new Database(path),
  drizzle: (sqlite) => drizzle(sqlite, { schema }),
};
