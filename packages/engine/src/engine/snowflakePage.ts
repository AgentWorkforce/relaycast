import { and, sql, type Column, type SQL } from 'drizzle-orm';
import * as sqlx from '../db/sqlx.js';
import { afterSnowflake, snowflakeDesc } from './retention.js';

/** One page query: `where` is the cursor bound (combine with the caller's filters). */
export type SnowflakePageQuery<T> = (where: SQL | undefined, orderBy: SQL, limit: number) => PromiseLike<T[]>;

/**
 * Newest-first keyset page over a decimal TEXT snowflake id column, ordered
 * numerically (`length(id), id`), honouring optional exclusive `before` and
 * `after` cursors.
 *
 * Ids widen over time (17 digits until 2025-10, 18 after), so text order is
 * not numeric order. A `before` page is read in at most two index seeks over a
 * `(…, length(id), id)` index: first the cursor's own width (`length(id) = L
 * AND id < before`, an index range), then, only if that page is short, the
 * narrower widths. A single `(length(id), id) < (L, before)` row-value bound
 * cannot seek in SQLite's expression index, so it would read every newer row
 * of the same width before reaching the page.
 */
export async function newestSnowflakePage<T>(
  source: sqlx.DialectSource,
  column: Column,
  opts: { before?: string; after?: string; limit: number },
  query: SnowflakePageQuery<T>,
): Promise<T[]> {
  const after = opts.after ? afterSnowflake(column, opts.after, source) : undefined;
  const desc = snowflakeDesc(column, source);
  if (!opts.before) return query(after, desc, opts.limit);

  const width = opts.before.length;
  const id = sqlx.binaryText(source, column);
  const rows = await query(
    and(sql`length(${column}) = ${width}`, sql`${id} < ${opts.before}`, after),
    sql`${id} DESC`,
    opts.limit,
  );
  // Narrower ids are all older; none can follow an `after` cursor this wide.
  if (rows.length >= opts.limit || (opts.after && opts.after.length >= width)) return rows;
  const older = await query(and(sql`length(${column}) < ${width}`, after), desc, opts.limit - rows.length);
  return [...rows, ...older];
}
