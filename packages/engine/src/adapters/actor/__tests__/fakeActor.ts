import Database from 'better-sqlite3';
import { createActorRuntime, type ActorRuntime, type ActorRuntimeOptions } from '../index.js';
import { SQLITE_CONSTRAINT_CODES, type ActorSql, type SqliteValue } from '../database.js';
import type { ActorWriteGroupFailure } from '../call-scope.js';
import type { ActorHttpRequest, ActorHttpResponse } from '../http.js';

const RUNTIME_OWNED = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM)\b/i;
const ALLOWED_PRAGMA = /^\s*PRAGMA\s+(table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list|foreign_key_check|integrity_check|quick_check|user_version)\b/i;

/**
 * An in-memory stand-in for a durable actor's database with the hosted
 * runtime's contract: one statement per `exec`, rows keyed by column name (a
 * repeated name keeps only its last value), transaction statements and most
 * PRAGMAs rejected, constraint errors without `code`, and the call as the only
 * transaction.
 */
export class FakeActorDatabase implements ActorSql {
  readonly raw = new Database(':memory:');
  statements = 0;

  constructor() {
    this.raw.pragma('foreign_keys = ON');
  }

  exec(sql: string, ...bindings: SqliteValue[]): object[] {
    if (RUNTIME_OWNED.test(sql)) throw new Error(`The actor runtime owns transactions: ${sql.slice(0, 40)}`);
    if (/^\s*PRAGMA\b/i.test(sql) && !ALLOWED_PRAGMA.test(sql)) throw new Error('PRAGMA not allowed');
    this.statements += 1;
    try {
      // better-sqlite3 refuses multi-statement strings in prepare(), like exec.
      const statement = this.raw.prepare(sql);
      // better-sqlite3 refuses all() on a statement without results; the
      // bun:sqlite facade (`npm run test:bun`) has no `reader` and allows it.
      if (statement.reader === false) {
        statement.run(...bindings);
        return [];
      }
      return statement.all(...bindings) as object[];
    } catch (error) {
      // The runtime reports constraint failures as plain errors with the
      // extended result code in the message and no `code` property.
      const code = (error as { code?: string }).code;
      const number = Object.entries(SQLITE_CONSTRAINT_CODES).find(([, name]) => name === code)?.[0];
      if (number) throw new Error(`${(error as Error).message}: Error code ${number}: constraint failed`);
      throw error;
    }
  }

  /** `@Atomic`: the whole call commits, or none of it does. */
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

/** A `Workspace` actor as the armadillo project defines it, over the fake runtime. */
export class FakeWorkspaceActor {
  readonly sql = new FakeActorDatabase();
  readonly alarm = new FakeAlarm();
  readonly runtime: ActorRuntime;
  readonly calls: { replay: number }[] = [];

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

  handle(request: ActorHttpRequest, replay: ActorWriteGroupFailure[]): Promise<ActorHttpResponse> {
    this.calls.push({ replay: replay.length });
    return this.sql.atomic(() => this.runtime.handle(request, replay));
  }

  maintain(): Promise<void> {
    return this.sql.atomic(() => this.runtime.maintain());
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
