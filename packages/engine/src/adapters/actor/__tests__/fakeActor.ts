import Database from 'better-sqlite3';
import { createActorRuntime, type ActorRuntime, type ActorRuntimeOptions } from '../index.js';
import { SQLITE_CONSTRAINT_CODES, type ActorSql, type SqliteValue } from '../database.js';
import type { ActorHttpRequest, ActorHttpResponse } from '../http.js';
import { createCredentialTagSigner } from '../../../auth/credentialTags.js';

/** The keyring the fake gateway signs workspace tags with. */
export const TEST_CREDENTIAL_TAGS = createCredentialTagSigner({ current: 'a', keys: { a: 'actor-test-tag-secret' } });

const RUNTIME_OWNED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i;
const ALLOWED_PRAGMA = /^\s*PRAGMA\s+(table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list|foreign_key_check|integrity_check|quick_check|user_version)\b/i;

/**
 * An in-memory stand-in for a durable actor's database with the runtime's
 * contract (durable-actors 0.14.5): one statement per `exec` (rows keyed by
 * column name, a repeated name keeps only its last value) or `query` (value
 * arrays plus column names), transaction statements and most PRAGMAs
 * rejected, constraint errors without `code`, each call one transaction, and
 * `transaction` nesting on savepoints.
 */
export class FakeActorDatabase implements ActorSql {
  readonly raw = new Database(':memory:');
  statements = 0;
  private savepoints = 0;

  constructor() {
    this.raw.pragma('foreign_keys = ON');
  }

  exec(sql: string, ...bindings: SqliteValue[]): object[] {
    return this.run(sql, (statement) => {
      // better-sqlite3 refuses all() on a statement without results; the
      // bun:sqlite facade (`npm run test:bun`) has no `reader` and allows it.
      if (statement.reader === false) {
        statement.run(...bindings);
        return [];
      }
      return statement.all(...bindings) as object[];
    });
  }

  query(sql: string, ...bindings: SqliteValue[]): { columns: string[]; rows: SqliteValue[][] } {
    return this.run(sql, (statement) => {
      if (statement.reader === false) {
        statement.run(...bindings);
        return { columns: [], rows: [] };
      }
      // better-sqlite3 names columns through columns(); the bun:sqlite facade through the native statement.
      const columns: string[] = typeof statement.columns === 'function'
        ? statement.columns().map((column) => column.name)
        : (statement as unknown as { stmt: { columnNames: string[] } }).stmt.columnNames;
      return { columns, rows: statement.raw(true).all(...bindings) as SqliteValue[][] };
    });
  }

  /** Nested transaction on a savepoint: if `operation` throws, only its writes roll back. */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const name = `fake_actor_${++this.savepoints}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = await operation();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  private run<T>(sql: string, body: (statement: Database.Statement) => T): T {
    if (RUNTIME_OWNED.test(sql)) throw new Error(`The actor runtime owns transactions: ${sql.slice(0, 40)}`);
    if (/^\s*PRAGMA\b/i.test(sql) && !ALLOWED_PRAGMA.test(sql)) throw new Error('PRAGMA not allowed');
    this.statements += 1;
    try {
      // better-sqlite3 refuses multi-statement strings in prepare(), like exec.
      return body(this.raw.prepare(sql));
    } catch (error) {
      // The runtime reports constraint failures as plain errors with the
      // extended result code in the message and no `code` property.
      const code = (error as { code?: string }).code;
      const number = Object.entries(SQLITE_CONSTRAINT_CODES).find(([, name]) => name === code)?.[0];
      if (number) throw new Error(`${(error as Error).message}: Error code ${number}: constraint failed`);
      throw error;
    }
  }

  /** An actor call: it commits, or rolls back when it throws. */
  async atomic<T>(call: () => Promise<T>): Promise<T> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = await call();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
}

export class FakeAlarm {
  at: number | null = null;
  get(): number | null { return this.at; }
  set(timestampMs: number): void { this.at = timestampMs; }
}

/** A `Workspace` actor as the example and armadillo define it, over the fake runtime. */
export class FakeWorkspaceActor {
  readonly sql = new FakeActorDatabase();
  readonly alarm = new FakeAlarm();
  readonly runtime: ActorRuntime;
  calls = 0;

  constructor(readonly id: string, options: Partial<ActorRuntimeOptions> = {}) {
    this.runtime = createActorRuntime({
      sql: this.sql,
      workspaceId: id,
      baseUrl: 'https://armadillo.test',
      fileSigningSecret: 'file-secret',
      outboundFetch: () => Promise.reject(new Error('no network in tests')),
      alarm: this.alarm,
      ...options,
      config: { environment: 'test', ...options.config },
    });
  }

  /**
   * One actor call, routed as the example gateway does: `POST /v1/workspaces`
   * goes to `create` with the tag the gateway's keyring signs for this id.
   */
  async handle(request: ActorHttpRequest): Promise<ActorHttpResponse> {
    this.calls += 1;
    if (request.method === 'POST' && new URL(request.url).pathname === '/v1/workspaces') {
      const tag = await TEST_CREDENTIAL_TAGS.tag(this.id);
      return this.sql.atomic(() => this.runtime.create(request, tag));
    }
    return this.sql.atomic(() => this.runtime.handle(request));
  }

  /** `onAlarm`: the firing alarm reads as set during the call and is consumed after it unless re-armed. */
  async maintain(): Promise<void> {
    const firing = this.alarm.at;
    try {
      await this.sql.atomic(() => this.runtime.maintain());
    } finally {
      if (this.alarm.at === firing) this.alarm.at = null;
    }
  }
}

export function jsonRequest(method: string, path: string, body?: unknown, token?: string): ActorHttpRequest {
  const headers: [string, string][] = [['content-type', 'application/json']];
  if (token) headers.push(['authorization', `Bearer ${token}`]);
  return {
    method,
    url: `https://armadillo.test${path}`,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
  };
}
