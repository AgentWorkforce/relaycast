/**
 * Which engine tables a workspace migration copies, in what order, and how
 * each table's rows are scoped to one workspace.
 *
 * Derived from `db/schema.ts` (the SQLite schema the actor runs; the Postgres
 * schema has the same tables and columns plus an explicit `rowid`), so a new
 * table is either picked up here or fails {@link migrationPlan} loudly.
 *
 * Order: parents before children along every foreign key (Kahn's algorithm,
 * ties broken by name, so the order is stable). The only self reference
 * (`messages.thread_id`) points at an older message, which a rowid-ordered
 * copy inserts first.
 */
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as sqliteSchema from '../../db/schema.js';

/** How a table's rows are selected for one workspace. */
export type MigrationScope =
  | { kind: 'workspace-row' }
  | { kind: 'workspace-column' }
  | { kind: 'parent'; column: string; parent: string; parentColumn: string }
  | { kind: 'storage-key-prefix'; column: string };

export interface MigrationTable {
  /** SQL table name. */
  readonly name: string;
  /** The SQLite (actor) table; its columns define the row encoding. */
  readonly table: SQLiteTable;
  /** Column names in schema order: the row encoding's positions. */
  readonly columns: readonly string[];
  readonly columnObjects: readonly SQLiteColumn[];
  readonly scope: MigrationScope;
}

/**
 * Tables a migration never copies, with the reason. Everything else in the
 * schema is copied.
 */
export const SKIPPED_TABLES: Readonly<Record<string, string>> = {
  // A deployment-wide maintenance cursor; the actor keeps its own.
  maintenance_cursors: 'deployment-wide maintenance state',
  // Maps legacy credential hashes to their ar_ replacements. Legacy
  // credentials cannot reach a workspace actor (the gateway routes only ar_
  // credentials), and the rows hold sealed credentials.
  credential_upgrades: 'legacy credential grace records cannot route on actors',
};

/** Tables without `workspace_id` reached through their storage key (`<workspace id>/...`). */
const STORAGE_KEY_TABLES: Readonly<Record<string, string>> = {
  file_cleanup_queue: 'storage_key',
};

let cached: readonly MigrationTable[] | undefined;

/** Every copied table, parents first. Throws for a table it cannot scope. */
export function migrationPlan(): readonly MigrationTable[] {
  cached ??= buildPlan();
  return cached;
}

export function migrationTable(name: string): MigrationTable | undefined {
  return migrationPlan().find((table) => table.name === name);
}

interface Node {
  name: string;
  table: SQLiteTable;
  columns: SQLiteColumn[];
  /** Referenced tables (excluding itself) and the single-column references. */
  parents: { table: string; column: string; parentColumn: string; multi: boolean }[];
}

function buildPlan(): MigrationTable[] {
  const nodes = new Map<string, Node>();
  for (const value of Object.values(sqliteSchema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    if (config.name in SKIPPED_TABLES) continue;
    nodes.set(config.name, {
      name: config.name,
      table: value,
      columns: config.columns,
      parents: config.foreignKeys.flatMap((fk) => {
        const ref = fk.reference();
        const parent = getTableName(ref.foreignTable);
        if (parent === config.name) return [];
        return [{
          table: parent,
          column: ref.columns[0]!.name,
          parentColumn: ref.foreignColumns[0]!.name,
          multi: ref.columns.length > 1,
        }];
      }),
    });
  }

  const order = topologicalOrder(nodes);
  const scopes = new Map<string, MigrationScope>();
  for (const name of order) {
    const node = nodes.get(name)!;
    scopes.set(name, scopeOf(node, scopes));
  }
  return order.map((name) => {
    const node = nodes.get(name)!;
    return {
      name,
      table: node.table,
      columns: node.columns.map((column) => column.name),
      columnObjects: node.columns,
      scope: scopes.get(name)!,
    };
  });
}

function scopeOf(node: Node, known: Map<string, MigrationScope>): MigrationScope {
  if (node.name === 'workspaces') return { kind: 'workspace-row' };
  if (node.columns.some((column) => column.name === 'workspace_id')) return { kind: 'workspace-column' };
  const keyColumn = STORAGE_KEY_TABLES[node.name];
  if (keyColumn) return { kind: 'storage-key-prefix', column: keyColumn };
  // The first single-column reference to an already-scoped table, by name.
  const parent = node.parents
    .filter((ref) => !ref.multi && known.has(ref.table))
    .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column))[0];
  if (!parent) {
    throw new Error(`migration plan: table ${node.name} has no workspace_id and no reference to a scoped table; add it to SKIPPED_TABLES or teach the plan its scope`);
  }
  return { kind: 'parent', column: parent.column, parent: parent.table, parentColumn: parent.parentColumn };
}

function topologicalOrder(nodes: Map<string, Node>): string[] {
  const pending = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    pending.set(node.name, new Set(node.parents.map((ref) => ref.table).filter((name) => nodes.has(name))));
  }
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      throw new Error(`migration plan: foreign key cycle among ${[...pending.keys()].sort().join(', ')}`);
    }
    for (const name of ready) {
      order.push(name);
      pending.delete(name);
      for (const deps of pending.values()) deps.delete(name);
    }
  }
  return order;
}
