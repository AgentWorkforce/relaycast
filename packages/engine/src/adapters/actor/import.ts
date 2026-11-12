/**
 * Importing a workspace exported from another backend (Postgres) into this
 * workspace actor, under the same workspace id: `migration/protocol.ts`.
 *
 * Every operation runs inside one actor call (one transaction): a chunk that
 * fails rolls back whole and can be resent. While an import is unfinished the
 * runtime answers every other request 503 `workspace_importing`, runs no
 * maintenance and the gateway's sockets cannot be granted, so nothing but the
 * import writes. The engine's triggers other than full-text search are
 * dropped for the import and restored by `finish` or `abort`: they derive
 * values (sequence high-water marks, liveness revisions, cleanup queues) that
 * the source already stored, and must not re-derive them over copied rows.
 */
import { migrationPlan, type MigrationTable } from '../migration/plan.js';
import { type ImportRequest } from '../migration/protocol.js';
import {
  assertRowOrder,
  blockDigest,
  normalizeValue,
  tableDigest,
  type MigrationRow,
  type MigrationValue,
  type TableDigest,
} from '../migration/rows.js';
import type { ActorCredentialTag } from './credential-tag.js';
import type { ActorSql } from './database.js';

const STATE = '_actor_import';
const CHUNKS = '_actor_import_chunks';

export const ACTOR_IMPORT_TABLE = {
  name: STATE,
  ddl: `CREATE TABLE IF NOT EXISTS ${STATE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'complete')),
    triggers TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  )`,
} as const;

export const ACTOR_IMPORT_CHUNKS_TABLE = {
  name: CHUNKS,
  ddl: `CREATE TABLE IF NOT EXISTS ${CHUNKS} (
    table_name TEXT NOT NULL,
    seq INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (table_name, seq)
  )`,
} as const;

/** Triggers the import keeps: full-text search must index the copied messages. */
const KEPT_TRIGGER = /^messages_fts_/;

interface ImportState {
  run_id: string;
  status: 'in_progress' | 'complete';
  triggers: string;
  started_at: number;
  finished_at: number | null;
}

export interface ImportResult {
  status: number;
  body: unknown;
}

const ok = (data: unknown, status = 200): ImportResult => ({ status, body: { ok: true, data } });
const fail = (status: number, code: string, message: string, details?: unknown): ImportResult => ({
  status,
  body: { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } },
});

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export class ActorImport {
  /** Cached between calls of one activation: undefined = not read yet. */
  private importingCache: boolean | undefined;

  constructor(private readonly sql: ActorSql, private readonly credentialTag: ActorCredentialTag) {}

  /** Whether an unfinished import owns this workspace. */
  importing(): boolean {
    this.importingCache ??= this.state()?.status === 'in_progress';
    return this.importingCache;
  }

  async run(request: ImportRequest, tag: string): Promise<ImportResult> {
    try {
      switch (request.op) {
        case 'status': return ok(this.describe());
        case 'begin': return this.begin(request, tag);
        case 'chunk': return await this.chunk(request);
        case 'finish': return await this.finish(request);
        case 'abort': return this.abort(request);
      }
    } finally {
      this.importingCache = undefined;
    }
  }

  private state(): ImportState | undefined {
    const [row] = this.sql.exec(`SELECT run_id, status, triggers, started_at, finished_at FROM ${STATE} WHERE id = 1`) as ImportState[];
    return row;
  }

  private describe(): unknown {
    const state = this.state();
    if (!state) return { status: 'none' };
    const chunks = this.sql.exec(`SELECT table_name, COUNT(*) AS chunks, SUM(row_count) AS rows FROM ${CHUNKS} GROUP BY table_name ORDER BY table_name`) as
      { table_name: string; chunks: number; rows: number }[];
    return {
      run_id: state.run_id,
      status: state.status,
      started_at: state.started_at,
      finished_at: state.finished_at,
      tables: Object.fromEntries(chunks.map((row) => [row.table_name, { chunks: Number(row.chunks), rows: Number(row.rows) }])),
    };
  }

  /** The state of `runId`, or the failure to answer when it is not the running import. */
  private running(runId: string): { state: ImportState } | { refused: ImportResult } {
    const state = this.state();
    if (!state) return { refused: fail(409, 'import_not_started', 'No import has begun on this workspace') };
    if (state.run_id !== runId) return { refused: fail(409, 'import_run_mismatch', 'Another import run owns this workspace') };
    if (state.status !== 'in_progress') return { refused: fail(409, 'import_complete', 'This import has already finished') };
    return { state };
  }

  private begin(request: Extract<ImportRequest, { op: 'begin' }>, tag: string): ImportResult {
    const state = this.state();
    if (state) {
      if (state.run_id !== request.run_id) return fail(409, 'import_run_mismatch', 'Another import run owns this workspace');
      if (state.status === 'complete') return fail(409, 'import_complete', 'This import has already finished');
      return ok(this.describe());
    }
    const [{ n }] = this.sql.exec('SELECT COUNT(*) AS n FROM workspaces') as { n: number }[];
    if (Number(n) > 0) return fail(409, 'workspace_exists', 'This workspace already holds data; an import needs an empty actor');

    const plan = migrationPlan();
    const mismatch = schemaMismatch(plan, request.tables);
    if (mismatch) return fail(409, 'import_schema_mismatch', `The export's schema differs from this engine's: ${mismatch}`);

    const triggers = (this.sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name`) as { name: string; sql: string }[])
      .filter((trigger) => !KEPT_TRIGGER.test(trigger.name));
    for (const trigger of triggers) this.sql.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    this.credentialTag.set(tag);
    this.sql.exec(
      `INSERT INTO ${STATE} (id, run_id, status, triggers, started_at) VALUES (1, ?, 'in_progress', ?, ?)`,
      request.run_id,
      JSON.stringify(triggers.map((trigger) => trigger.sql)),
      Date.now(),
    );
    return ok(this.describe(), 201);
  }

  private async chunk(request: Extract<ImportRequest, { op: 'chunk' }>): Promise<ImportResult> {
    const running = this.running(request.run_id);
    if ('refused' in running) return running.refused;
    const table = migrationPlan().find((entry) => entry.name === request.table);
    if (!table) return fail(400, 'invalid_request', `Table ${request.table} is not part of a migration`);

    const [done] = this.sql.exec(`SELECT row_count, sha256 FROM ${CHUNKS} WHERE table_name = ? AND seq = ?`, table.name, request.seq) as
      { row_count: number; sha256: string }[];
    if (done) return ok({ table: table.name, seq: request.seq, count: Number(done.row_count), sha256: done.sha256, duplicate: true });
    const [{ n: received }] = this.sql.exec(`SELECT COUNT(*) AS n FROM ${CHUNKS} WHERE table_name = ?`, table.name) as { n: number }[];
    if (request.seq !== Number(received)) {
      return fail(409, 'import_chunk_out_of_order', `${table.name}: expected chunk ${Number(received)}, got ${request.seq}`);
    }

    const width = table.columns.length + 1;
    if (request.rows.some((row) => row.length !== width)) {
      return fail(400, 'invalid_request', `${table.name}: every row is [rowid, ...${table.columns.length} values]`);
    }
    const [{ last }] = this.sql.exec(`SELECT MAX(rowid) AS last FROM ${quote(table.name)}`) as { last: number | null }[];
    try {
      assertRowOrder(table.name, request.rows, last === null ? undefined : Number(last));
    } catch (error) {
      return fail(400, 'invalid_request', (error as Error).message);
    }

    const columns = ['rowid', ...table.columns.map(quote)].join(', ');
    const insert = `INSERT INTO ${quote(table.name)} (${columns}) VALUES (${Array.from({ length: width }, () => '?').join(', ')})`;
    for (const row of request.rows) this.sql.exec(insert, ...(row as MigrationValue[]));

    const first = request.rows[0]![0] as number;
    const lastRowid = request.rows[request.rows.length - 1]![0] as number;
    const stored = this.readRows(table, first, lastRowid);
    if (stored.length !== request.rows.length) {
      throw new Error(`${table.name}: read back ${stored.length} rows for a chunk of ${request.rows.length}`);
    }
    const sha256 = await blockDigest(stored);
    this.sql.exec(`INSERT INTO ${CHUNKS} (table_name, seq, row_count, sha256) VALUES (?, ?, ?, ?)`, table.name, request.seq, stored.length, sha256);
    return ok({ table: table.name, seq: request.seq, count: stored.length, sha256 });
  }

  private readRows(table: MigrationTable, from: number, to: number): MigrationRow[] {
    const { rows } = this.sql.query(
      `SELECT rowid, ${table.columns.map(quote).join(', ')} FROM ${quote(table.name)} WHERE rowid BETWEEN ? AND ? ORDER BY rowid`,
      from,
      to,
    );
    return rows.map((row) => row.map((value, index) =>
      normalizeValue(table.name, index === 0 ? 'rowid' : table.columns[index - 1]!, value)) as MigrationRow);
  }

  private async finish(request: Extract<ImportRequest, { op: 'finish' }>): Promise<ImportResult> {
    const running = this.running(request.run_id);
    if ('refused' in running) return running.refused;

    const violations = this.sql.exec('PRAGMA foreign_key_check') as { table: string; rowid: number; parent: string }[];
    if (violations.length > 0) {
      return fail(409, 'import_integrity_failed', `${violations.length} rows reference missing parents`,
        violations.slice(0, 20).map((v) => ({ table: v.table, rowid: Number(v.rowid), parent: v.parent })));
    }

    const digests: Record<string, TableDigest> = {};
    const mismatches: { table: string; expected: TableDigest | null; actual: TableDigest }[] = [];
    for (const table of migrationPlan()) {
      const [{ n }] = this.sql.exec(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`) as { n: number }[];
      const blocks = (this.sql.exec(`SELECT sha256 FROM ${CHUNKS} WHERE table_name = ? ORDER BY seq`, table.name) as { sha256: string }[])
        .map((row) => row.sha256);
      const actual = await tableDigest(blocks, Number(n));
      digests[table.name] = actual;
      const expected = request.manifest[table.name] ?? null;
      if (!expected || expected.count !== actual.count || expected.sha256 !== actual.sha256) {
        mismatches.push({ table: table.name, expected, actual });
      }
    }
    const unknown = Object.keys(request.manifest).filter((name) => !(name in digests));
    if (mismatches.length > 0 || unknown.length > 0) {
      return fail(409, 'import_verification_failed', 'The imported rows do not match the export manifest', { mismatches, unknown_tables: unknown });
    }

    this.restoreTriggers(running.state);
    this.sql.exec(`UPDATE ${STATE} SET status = 'complete', finished_at = ? WHERE id = 1`, Date.now());
    return ok({ run_id: request.run_id, status: 'complete', tables: digests });
  }

  private abort(request: Extract<ImportRequest, { op: 'abort' }>): ImportResult {
    const running = this.running(request.run_id);
    if ('refused' in running) return running.refused;
    for (const table of [...migrationPlan()].reverse()) this.sql.exec(`DELETE FROM ${quote(table.name)}`);
    this.restoreTriggers(running.state);
    this.sql.exec(`DELETE FROM ${CHUNKS}`);
    this.sql.exec(`DELETE FROM ${STATE}`);
    return ok({ run_id: request.run_id, status: 'aborted' });
  }

  private restoreTriggers(state: ImportState): void {
    for (const ddl of JSON.parse(state.triggers) as string[]) this.sql.exec(ddl);
  }
}

/** The first difference between the plan and an export's table list, or undefined. */
export function schemaMismatch(plan: readonly MigrationTable[], tables: readonly { name: string; columns: readonly string[] }[]): string | undefined {
  if (tables.length !== plan.length) {
    const exported = new Set(tables.map((table) => table.name));
    const ours = new Set(plan.map((table) => table.name));
    const missing = plan.filter((table) => !exported.has(table.name)).map((table) => table.name);
    const extra = tables.filter((table) => !ours.has(table.name)).map((table) => table.name);
    return `table lists differ (missing ${missing.join(', ') || 'none'}; unknown ${extra.join(', ') || 'none'})`;
  }
  for (let i = 0; i < plan.length; i += 1) {
    const ours = plan[i]!;
    const theirs = tables[i]!;
    if (ours.name !== theirs.name) return `table ${i} is ${theirs.name}, expected ${ours.name}`;
    if (ours.columns.join(',') !== theirs.columns.join(',')) {
      return `${ours.name} columns are (${theirs.columns.join(', ')}), expected (${ours.columns.join(', ')})`;
    }
  }
  return undefined;
}
