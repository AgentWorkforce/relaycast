/**
 * A workspace's SQLite file as the engine's actor runtime expects its
 * database (`ActorSql`): one statement per `exec` / `query`, transactions
 * owned by the host (each call is one `BEGIN IMMEDIATE` … `COMMIT`), and
 * `transaction` nesting on savepoints.
 *
 * The file runs in WAL mode with automatic checkpoints and cache spills off,
 * so every committed transaction lands in the WAL as whole frames and nothing
 * uncommitted ever does: the host ships exactly the frames a commit appended
 * (see `wal.ts`) and checkpoints only after a base snapshot is durable.
 */
import Database from 'better-sqlite3';
import type { ActorSql, SqliteValue } from '@relaycast/engine/adapters/actor';

const HOST_OWNED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i;
export const PAGE_SIZE = 4096;

export class WorkspaceDatabase implements ActorSql {
  readonly raw: Database.Database;
  private savepoints = 0;

  constructor(readonly path: string) {
    this.raw = new Database(path);
    this.raw.pragma(`page_size = ${PAGE_SIZE}`);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('wal_autocheckpoint = 0');
    this.raw.pragma('cache_spill = OFF');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('foreign_keys = ON');
  }

  exec(sql: string, ...bindings: SqliteValue[]): object[] {
    const statement = this.prepare(sql);
    if (statement.reader === false) {
      statement.run(...bindings);
      return [];
    }
    return statement.all(...bindings) as object[];
  }

  query(sql: string, ...bindings: SqliteValue[]): { columns: string[]; rows: SqliteValue[][] } {
    const statement = this.prepare(sql);
    if (statement.reader === false) {
      statement.run(...bindings);
      return { columns: [], rows: [] };
    }
    return { columns: statement.columns().map((column) => column.name), rows: statement.raw(true).all(...bindings) as SqliteValue[][] };
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const name = `ws_tx_${++this.savepoints}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await operation();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      this.savepoints -= 1;
    }
  }

  /** One host call: commits, or rolls back when `call` throws. */
  async atomic<T>(call: () => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = await call();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.raw.inTransaction) this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  /** Folds the WAL into the file and empties it; only between calls. */
  checkpoint(): void {
    const [result] = this.raw.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
    if (result?.busy) throw new Error('WAL checkpoint was blocked');
  }

  close(): void {
    this.raw.close();
  }

  private prepare(sql: string): Database.Statement {
    if (HOST_OWNED.test(sql)) throw new Error(`The host owns transactions: ${sql.slice(0, 40)}`);
    return this.raw.prepare(sql);
  }
}
