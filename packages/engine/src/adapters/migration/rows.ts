/**
 * The wire form of migrated rows and their checksums.
 *
 * A row travels as `[rowid, ...values]`, values in the table's schema column
 * order, each exactly what the actor's SQLite stores for it (the SQLite
 * column's own driver mapping: timestamps as epoch seconds, booleans as 0/1,
 * JSON as text).
 *
 * Rows move in blocks (one export line, one import chunk). A block's digest is
 * the sha256 of its rows, one JSON line each; a table's digest is the sha256 of
 * its block digests, one per line, in order. The exporter digests what it
 * sends; the actor digests what it reads back after inserting each block, so
 * equal table digests mean the stored bytes are what was exported, in the same
 * rowid order. WebCrypto only: this runs inside workspace actors too.
 */
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sha256Hex } from '../../lib/crypto.js';

/** A stored SQLite value as the migration carries it. */
export type MigrationValue = string | number | null;

/** One row: `[rowid, ...values]`. */
export type MigrationRow = [number, ...MigrationValue[]];

/** Count and digest of one table's rows. */
export interface TableDigest {
  count: number;
  sha256: string;
}

/**
 * Encode one row read through drizzle (JS values, keyed by SQL column name)
 * into the stored SQLite form, using each SQLite column's driver mapping.
 */
export function encodeRow(
  table: string,
  rowid: number,
  columns: readonly SQLiteColumn[],
  values: Readonly<Record<string, unknown>>,
): MigrationRow {
  const row: MigrationRow = [rowid];
  for (const column of columns) {
    if (!(column.name in values)) throw new Error(`${table}.${column.name}: missing from the source row`);
    const value = values[column.name];
    row.push(value === null || value === undefined ? null : normalizeValue(table, column.name, column.mapToDriverValue(value)));
  }
  return row;
}

/** A value read back from SQLite (or produced by a driver mapping) in migration form. */
export function normalizeValue(table: string, column: string, value: unknown): MigrationValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${table}.${column}: non-finite number`);
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${table}.${column}: integer ${value} exceeds the safe range`);
    }
    return Number(value);
  }
  throw new Error(`${table}.${column}: unsupported stored value of type ${value instanceof Uint8Array ? 'blob' : typeof value}`);
}

/** Throw unless rowids strictly increase within the block and after `afterRowid`. */
export function assertRowOrder(table: string, rows: readonly (readonly unknown[])[], afterRowid = Number.NEGATIVE_INFINITY): void {
  let last = afterRowid;
  for (const row of rows) {
    const rowid = row[0];
    if (typeof rowid !== 'number' || !Number.isSafeInteger(rowid) || !(rowid > last)) {
      throw new Error(`${table}: rows must carry increasing integer rowids (at ${String(rowid)})`);
    }
    last = rowid;
  }
}

export function blockDigest(rows: readonly MigrationRow[]): Promise<string> {
  return sha256Hex(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}

export async function tableDigest(blockDigests: readonly string[], count: number): Promise<TableDigest> {
  return { count, sha256: await sha256Hex(blockDigests.map((digest) => `${digest}\n`).join('')) };
}
