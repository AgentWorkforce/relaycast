/**
 * Export workspaces from a Postgres-backed engine for import into workspace
 * actors (`relaycast-pg-export`).
 *
 * Everything is read in one `REPEATABLE READ READ ONLY` transaction, so all
 * workspaces come from one snapshot. Each workspace gets a directory:
 *
 *   <out>/<workspace id>/manifest.json   tables (plan order) with columns, count, sha256, blocks
 *   <out>/<workspace id>/<table>.ndjson  one sealed block of rows per line (`sealing.ts`, `rows.ts`)
 *
 * Blocks are bounded by rows and by serialized bytes, so each fits one import
 * request. Lines are sealed with a key derived from the internal secret
 * (subscription signing secrets and headers are in the rows); directories are
 * 0700 and files 0600. Nothing is logged but counts and ids.
 */
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { and, asc, eq, getTableColumns, getTableName, gt, inArray, is, like, sql, type SQL } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as pgSchema from '../../db/schema.pg.js';
import { migrationPlan, type MigrationTable } from './plan.js';
import { blockDigest, encodeRow, tableDigest, type MigrationRow, type TableDigest } from './rows.js';
import { MAX_IMPORT_BODY_BYTES } from './protocol.js';
import { SEALING, blockPlace, exportKey, sealBlock } from './sealing.js';

export const EXPORT_FORMAT = 1;
export const DEFAULT_BLOCK_ROWS = 500;
/** A block's serialized rows stay under this, well inside one import request. */
export const DEFAULT_BLOCK_BYTES = 4 * 1024 * 1024;
/** The largest single row an import request can carry, with room for its envelope. */
export const MAX_ROW_BYTES = MAX_IMPORT_BODY_BYTES - 64 * 1024;

export interface ManifestTable extends TableDigest {
  name: string;
  columns: string[];
  blocks: number;
}

export interface WorkspaceManifest {
  format: typeof EXPORT_FORMAT;
  run_id: string;
  workspace_id: string;
  exported_at: string;
  /** How the NDJSON lines are sealed. */
  sealing: typeof SEALING;
  tables: ManifestTable[];
}

const pgTables = new Map<string, PgTable>();
for (const value of Object.values(pgSchema)) {
  if (is(value, PgTable)) pgTables.set(getTableName(value), value);
}

function pgTableFor(name: string): PgTable {
  const table = pgTables.get(name);
  if (!table) throw new Error(`export: no Postgres table ${name}`);
  return table;
}

function pgColumn(table: PgTable, name: string): PgColumn {
  const column = Object.values(getTableColumns(table)).find((col) => col.name === name);
  if (!column) throw new Error(`export: ${getTableName(table)} has no column ${name}`);
  return column as PgColumn;
}

/** The condition selecting `table`'s rows of one workspace. */
function scopeCondition(db: NodePgDatabase<typeof pgSchema>, table: MigrationTable, workspaceId: string): SQL {
  const pgTable = pgTableFor(table.name);
  const scope = table.scope;
  switch (scope.kind) {
    case 'workspace-row':
      return eq(pgColumn(pgTable, 'id'), workspaceId);
    case 'workspace-column':
      return eq(pgColumn(pgTable, 'workspace_id'), workspaceId);
    case 'storage-key-prefix':
      if (!/^[0-9]+$/.test(workspaceId)) throw new Error('export: workspace ids are snowflakes');
      return like(pgColumn(pgTable, scope.column), `${workspaceId}/%`);
    case 'parent': {
      const parent = migrationPlan().find((entry) => entry.name === scope.parent)!;
      const parentTable = pgTableFor(parent.name);
      const parentIds = db.select({ value: pgColumn(parentTable, scope.parentColumn) })
        .from(parentTable)
        .where(scopeCondition(db, parent, workspaceId));
      return inArray(pgColumn(pgTable, scope.column), parentIds);
    }
  }
}

/** Every workspace id in the database, oldest first. */
export async function listWorkspaces(client: pg.ClientBase): Promise<string[]> {
  const result = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY rowid');
  return result.rows.map((row) => row.id);
}

export interface ExportOptions {
  runId: string;
  outDir: string;
  workspaceIds: readonly string[];
  /** The deployment's internal secret: the block key is derived from it. */
  internalSecret: string;
  blockRows?: number;
  blockBytes?: number;
  log?: (line: string) => void;
}

/**
 * Export `workspaceIds` from `client`, which must already be inside the
 * snapshot transaction ({@link beginSnapshot}).
 */
export async function exportWorkspaces(client: pg.ClientBase, options: ExportOptions): Promise<WorkspaceManifest[]> {
  const db = drizzle(client as pg.PoolClient, { schema: pgSchema });
  const key = await exportKey(options.internalSecret, options.runId);
  await mkdir(options.outDir, { recursive: true, mode: 0o700 });
  await chmod(options.outDir, 0o700);
  const manifests: WorkspaceManifest[] = [];
  for (const workspaceId of options.workspaceIds) {
    manifests.push(await exportWorkspace(db, workspaceId, key, options));
  }
  return manifests;
}

async function exportWorkspace(db: NodePgDatabase<typeof pgSchema>, workspaceId: string, key: CryptoKey, options: ExportOptions): Promise<WorkspaceManifest> {
  const blockRows = options.blockRows ?? DEFAULT_BLOCK_ROWS;
  const blockBytes = Math.min(options.blockBytes ?? DEFAULT_BLOCK_BYTES, MAX_ROW_BYTES);
  const dir = join(options.outDir, workspaceId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tables: ManifestTable[] = [];
  for (const table of migrationPlan()) {
    const pgTable = pgTableFor(table.name);
    const rowidColumn = pgColumn(pgTable, 'rowid');
    const properties = Object.entries(getTableColumns(pgTable)).map(([property, column]) => [property, column.name] as const);
    const scope = scopeCondition(db, table, workspaceId);

    const path = join(dir, `${table.name}.ndjson`);
    const out = createWriteStream(`${path}.partial`, { flags: 'w', mode: 0o600 });
    const digests: string[] = [];
    let count = 0;
    let after = -1;
    let block: MigrationRow[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (block.length === 0) return;
      digests.push(await blockDigest(block));
      const line = await sealBlock(key, blockPlace(workspaceId, table.name, digests.length - 1), JSON.stringify(block));
      if (!out.write(`${line}\n`)) await once(out, 'drain');
      count += block.length;
      block = [];
      bytes = 0;
    };
    for (;;) {
      const rows = await db.select().from(pgTable)
        .where(and(scope, gt(rowidColumn, after)))
        .orderBy(asc(rowidColumn))
        .limit(blockRows) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const byColumn: Record<string, unknown> = {};
        for (const [property, column] of properties) byColumn[column] = row[property];
        const encoded = encodeRow(table.name, Number(byColumn.rowid), table.columnObjects, byColumn);
        const size = Buffer.byteLength(JSON.stringify(encoded)) + 1;
        if (size > MAX_ROW_BYTES) {
          throw new Error(`${table.name} row ${encoded[0]}: a ${size}-byte row exceeds the ${MAX_ROW_BYTES}-byte import limit`);
        }
        if (block.length > 0 && (block.length >= blockRows || bytes + size > blockBytes)) await flush();
        block.push(encoded);
        bytes += size;
        after = encoded[0];
      }
      if (rows.length < blockRows) break;
    }
    await flush();
    out.end();
    await once(out, 'finish');
    await rename(`${path}.partial`, path);
    tables.push({ name: table.name, columns: [...table.columns], blocks: digests.length, ...(await tableDigest(digests, count)) });
    options.log?.(`export ${workspaceId} ${table.name}: ${count} rows`);
  }
  const manifest: WorkspaceManifest = {
    format: EXPORT_FORMAT,
    run_id: options.runId,
    workspace_id: workspaceId,
    exported_at: new Date().toISOString(),
    sealing: SEALING,
    tables,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** Open the export's snapshot: every later read sees one consistent state. */
export async function beginSnapshot(client: pg.ClientBase): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

/** Per-workspace row counts of every copied table (preflight). */
export async function countWorkspace(client: pg.ClientBase, workspaceId: string): Promise<Record<string, number>> {
  const db = drizzle(client as pg.PoolClient, { schema: pgSchema });
  const counts: Record<string, number> = {};
  for (const table of migrationPlan()) {
    const pgTable = pgTableFor(table.name);
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pgTable).where(scopeCondition(db, table, workspaceId));
    counts[table.name] = Number(row?.n ?? 0);
  }
  return counts;
}
