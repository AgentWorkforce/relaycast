/**
 * Export workspaces from a Postgres-backed engine for import into workspace
 * actors (`relaycast-pg-export`).
 *
 * Everything is read in one `REPEATABLE READ READ ONLY` transaction, so all
 * workspaces come from one snapshot. Each workspace gets a directory:
 *
 *   <out>/<workspace id>/manifest.json   tables (plan order) with columns, count, sha256, blocks
 *   <out>/<workspace id>/<table>.ndjson  one block of rows per line (`migration/rows.ts`)
 *
 * Rows hold credential hashes, never plaintext credentials. Nothing is logged
 * but counts and ids.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { and, asc, eq, getTableColumns, getTableName, gt, inArray, is, like, sql, type SQL } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import * as pgSchema from '../../db/schema.pg.js';
import { migrationPlan, type MigrationTable } from './plan.js';
import { blockDigest, encodeRow, tableDigest, type MigrationRow, type TableDigest } from './rows.js';

export const EXPORT_FORMAT = 1;
export const DEFAULT_BLOCK_ROWS = 500;

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
  blockRows?: number;
  log?: (line: string) => void;
}

/**
 * Export `workspaceIds` from `client`, which must already be inside the
 * snapshot transaction ({@link beginSnapshot}).
 */
export async function exportWorkspaces(client: pg.ClientBase, options: ExportOptions): Promise<WorkspaceManifest[]> {
  const db = drizzle(client as pg.PoolClient, { schema: pgSchema });
  const manifests: WorkspaceManifest[] = [];
  for (const workspaceId of options.workspaceIds) {
    manifests.push(await exportWorkspace(db, workspaceId, options));
  }
  return manifests;
}

async function exportWorkspace(db: NodePgDatabase<typeof pgSchema>, workspaceId: string, options: ExportOptions): Promise<WorkspaceManifest> {
  const blockRows = options.blockRows ?? DEFAULT_BLOCK_ROWS;
  const dir = join(options.outDir, workspaceId);
  await mkdir(dir, { recursive: true });
  const tables: ManifestTable[] = [];
  for (const table of migrationPlan()) {
    const pgTable = pgTableFor(table.name);
    const rowidColumn = pgColumn(pgTable, 'rowid');
    const properties = Object.entries(getTableColumns(pgTable)).map(([property, column]) => [property, column.name] as const);
    const scope = scopeCondition(db, table, workspaceId);

    const path = join(dir, `${table.name}.ndjson`);
    const out = createWriteStream(`${path}.partial`, { flags: 'w' });
    const digests: string[] = [];
    let count = 0;
    let after = -1;
    for (;;) {
      const rows = await db.select().from(pgTable)
        .where(and(scope, gt(rowidColumn, after)))
        .orderBy(asc(rowidColumn))
        .limit(blockRows) as Record<string, unknown>[];
      if (rows.length === 0) break;
      const block: MigrationRow[] = rows.map((row) => {
        const byColumn: Record<string, unknown> = {};
        for (const [property, column] of properties) byColumn[column] = row[property];
        return encodeRow(table.name, Number(byColumn.rowid), table.columnObjects, byColumn);
      });
      digests.push(await blockDigest(block));
      if (!out.write(`${JSON.stringify(block)}\n`)) await once(out, 'drain');
      count += block.length;
      after = block[block.length - 1]![0];
      if (rows.length < blockRows) break;
    }
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
    tables,
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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
