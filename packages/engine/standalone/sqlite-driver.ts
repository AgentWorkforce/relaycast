/**
 * `bun:sqlite` implementation of the Node adapter's SQLite driver seam.
 *
 * The standalone build (`standalone/build.ts`) swaps this module in for
 * `src/adapters/node/sqlite-driver.ts`, so the compiled binary needs no native
 * addon. {@link BunSqliteDatabase} is a facade that gives `bun:sqlite` the
 * better-sqlite3 surface the adapter and its tests use, normalizing the
 * differences that matter:
 *
 * - `stmt.get()` with no row returns `undefined` (bun:sqlite returns `null`).
 * - `stmt.run()` reports the statement's own `changes` / `lastInsertRowid`
 *   (bun:sqlite includes rows written by FK actions and triggers).
 * - Named parameters bind without a sigil prefix (`strict: true`), and a
 *   missing parameter throws, as in better-sqlite3.
 * - `pragma(source, { simple })` exists (bun:sqlite has no `pragma()`).
 * - `open` reflects whether the connection is still open.
 * - `backup(path)` writes a consistent snapshot via `serialize()`.
 * - `exec(sql)` runs a multi-statement script one statement at a time and stops
 *   at the first error. bun:sqlite's own `exec` silently swallows the error of
 *   any statement that is not the last one (trailing whitespace counts as a
 *   following statement), and its `prepare` silently ignores everything after
 *   the first statement; better-sqlite3 throws in both cases. Without this a
 *   failing migration statement would be skipped and the migration recorded as
 *   applied.
 */
import { writeFileSync } from 'node:fs';
import { Database, type Statement } from 'bun:sqlite';
import type { DrizzleConfig } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from '../src/db/schema.js';
import type { SqliteConnection, SqliteDriver } from '../src/adapters/node/sqlite-driver.js';

type Params = unknown[];

interface SqlChunk {
  text: string;
  /** False when the chunk is only whitespace and comments. */
  hasCode: boolean;
}

/**
 * Split a SQL script after every `;` that sits outside string literals, quoted
 * identifiers, and comments. A chunk may still be an incomplete statement (a
 * `CREATE TRIGGER ... BEGIN ...;` body); the caller detects that via SQLite's
 * own "incomplete input" error and joins chunks until the statement compiles.
 */
export function splitSqlChunks(sql: string): SqlChunk[] {
  const chunks: SqlChunk[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;
  const closeOf: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch in closeOf) {
      // A doubled quote inside a literal re-enters the same state on the next
      // iteration, so escaped quotes need no special case.
      const end = sql.indexOf(closeOf[ch], i + 1);
      i = end === -1 ? sql.length : end + 1;
      hasCode = true;
    } else if (ch === ';') {
      i += 1;
      chunks.push({ text: sql.slice(start, i), hasCode: true });
      start = i;
      hasCode = false;
    } else {
      if (!/\s/.test(ch)) hasCode = true;
      i += 1;
    }
  }
  if (start < sql.length) chunks.push({ text: sql.slice(start), hasCode });
  return chunks;
}

function isIncompleteInput(err: unknown): boolean {
  return err instanceof Error && /incomplete input/i.test(err.message);
}

class BunSqliteStatement {
  #raw = false;

  constructor(
    private readonly stmt: Statement,
    private readonly db: Database,
    private readonly live?: Set<BunSqliteStatement>,
  ) {
    live?.add(this);
  }

  run(...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.stmt.run(...(params as never[]));
    // bun:sqlite reports the `total_changes()` delta, which also counts rows
    // touched by FK actions and triggers, and a trigger's insert rowid.
    // better-sqlite3 reports the statement's own `changes()` and
    // `last_insert_rowid()`.
    const own = this.db
      .query('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid')
      .get() as { changes: number; lastInsertRowid: number };
    return { changes: result.changes === 0 ? 0 : own.changes, lastInsertRowid: own.lastInsertRowid };
  }

  get(...params: Params): unknown {
    if (this.#raw) return this.stmt.values(...(params as never[]))[0];
    const row = this.stmt.get(...(params as never[]));
    return row === null ? undefined : row;
  }

  all(...params: Params): unknown[] {
    return this.#raw ? this.stmt.values(...(params as never[])) : this.stmt.all(...(params as never[]));
  }

  /** better-sqlite3's raw mode: rows come back as value arrays. */
  raw(toggle = true): this {
    this.#raw = toggle;
    return this;
  }

  /** Row value arrays (drizzle's bun-sqlite session calls this); runs through `all` in raw mode, as better-sqlite3 does. */
  values(...params: Params): unknown[][] {
    const previous = this.#raw;
    this.#raw = true;
    try {
      return this.all(...params) as unknown[][];
    } finally {
      this.#raw = previous;
    }
  }

  iterate(...params: Params): IterableIterator<unknown> {
    return this.stmt.iterate(...(params as never[]));
  }

  finalize(): void {
    if (this.live && !this.live.delete(this)) return;
    this.stmt.finalize();
  }
}

export class BunSqliteDatabase {
  readonly native: Database;
  readonly name: string;
  readonly memory: boolean;
  #open = true;
  /**
   * Statements from `prepare()`. bun:sqlite closes with `sqlite3_close_v2`, so a
   * connection with unfinalized statements stays open until they are collected;
   * better-sqlite3 finalizes them on `close()`, and so does this facade.
   */
  readonly #live = new Set<BunSqliteStatement>();

  constructor(path = ':memory:') {
    this.native = new Database(path, { create: true, strict: true });
    this.name = path;
    this.memory = path === ':memory:' || path === '';
  }

  get open(): boolean {
    return this.#open;
  }

  get inTransaction(): boolean {
    return this.native.inTransaction;
  }

  exec(sql: string): this {
    for (const stmt of this.#statements(sql)) {
      try {
        stmt.run();
      } finally {
        stmt.finalize();
      }
    }
    return this;
  }

  /**
   * Compile `sql` one complete statement at a time. Each statement is yielded
   * before the next is compiled, so DDL earlier in a script is visible to later
   * statements when the caller runs each as it arrives.
   */
  *#statements(sql: string): Generator<Statement> {
    let pending = '';
    let pendingHasCode = false;
    for (const chunk of splitSqlChunks(sql)) {
      pending += chunk.text;
      pendingHasCode ||= chunk.hasCode;
      if (!pendingHasCode) {
        pending = '';
        continue;
      }
      let stmt: Statement;
      try {
        stmt = this.native.prepare(pending);
      } catch (err) {
        if (isIncompleteInput(err)) continue;
        throw err;
      }
      yield stmt;
      pending = '';
      pendingHasCode = false;
    }
    // A trailing statement that never completed: let SQLite report it.
    if (pendingHasCode) yield this.native.prepare(pending);
  }

  prepare(sql: string): BunSqliteStatement {
    if (splitSqlChunks(sql).filter((chunk) => chunk.hasCode).length > 1) {
      // Possibly several statements (or one trigger with `;` in its body).
      // bun:sqlite would silently compile only the first; reject like
      // better-sqlite3 instead.
      const statements = [...this.#statements(sql)];
      for (const stmt of statements.slice(1)) stmt.finalize();
      if (statements.length > 1) {
        statements[0].finalize();
        throw new RangeError('The supplied SQL string contains more than one statement');
      }
      return new BunSqliteStatement(statements[0], this.native, this.#live);
    }
    return new BunSqliteStatement(this.native.prepare(sql), this.native, this.#live);
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const stmt = this.native.prepare(`PRAGMA ${source}`);
    let rows: Record<string, unknown>[];
    try {
      rows = stmt.all() as Record<string, unknown>[];
    } finally {
      stmt.finalize();
    }
    if (!options.simple) return rows;
    const first = rows[0];
    return first === undefined ? undefined : Object.values(first)[0];
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    return this.native.transaction(fn) as unknown as F;
  }

  function(name: string): never {
    throw new Error(`bun:sqlite does not support user-defined SQL functions (${name})`);
  }

  async backup(destination: string): Promise<{ totalPages: number; remainingPages: number }> {
    writeFileSync(destination, this.native.serialize());
    return { totalPages: 0, remainingPages: 0 };
  }

  close(): this {
    if (this.#open) {
      for (const stmt of [...this.#live]) {
        try {
          stmt.finalize();
        } catch {
          // Already finalized natively; closing must not fail over it.
        }
      }
      this.native.close();
      this.#open = false;
    }
    return this;
  }
}

/**
 * Drizzle runs over the facade rather than the native handle, so its
 * statements get the same normalization (and the same `prepare` seam) as
 * direct callers.
 */
export function drizzleOver(sqlite: unknown, config: DrizzleConfig<Record<string, unknown>> = {}) {
  return drizzle(sqlite as Database, config);
}

export const sqliteDriver: SqliteDriver = {
  name: 'bun:sqlite',
  open: (path) => new BunSqliteDatabase(path) as unknown as SqliteConnection,
  drizzle: (sqlite) => drizzleOver(sqlite, { schema }),
};
