import { and, sql, type Column, type SQL } from 'drizzle-orm';
import * as sqlx from '../db/sqlx.js';
import { snowflakeDesc } from './retention.js';

/** One page query: `where` is the cursor bound (combine with the caller's filters). */
export type SnowflakePageQuery<T> = (where: SQL | undefined, orderBy: SQL, limit: number) => PromiseLike<T[]>;

/**
 * Newest-first keyset page over a decimal TEXT snowflake id column, ordered
 * numerically (`length(id), id`), honouring optional exclusive `before` and
 * `after` cursors.
 *
 * Ids widen over time (17 digits until 2025-10, 18 after), so text order is
 * not numeric order. SQLite cannot seek a row-value bound such as
 * `(length(id), id) > (L, after)` through a `(…, length(id), id)` expression
 * index: it would walk the whole history newest-first and filter, so an empty
 * poll after the newest id reads every row. Instead the interval is split by
 * width into at most three bands, each an index range read newest-first, and
 * later bands run only while the page is short:
 *
 * 1. the `before` cursor's width: `length(id) = B AND id < before`;
 * 2. the widths strictly between the cursors: `length(id) < B AND length(id) > A`;
 * 3. the `after` cursor's width: `length(id) = A AND id > after`.
 *
 * When both cursors have the same width, band 1 carries both bounds and is the
 * only band.
 */
export async function newestSnowflakePage<T>(
  source: sqlx.DialectSource,
  column: Column,
  opts: { before?: string; after?: string; limit: number },
  query: SnowflakePageQuery<T>,
): Promise<T[]> {
  const { before, after, limit } = opts;
  const desc = snowflakeDesc(column, source);
  if (!before && !after) return query(undefined, desc, limit);

  const id = sqlx.binaryText(source, column);
  const width = sql`length(${column})`;
  const bands: Array<[SQL | undefined, SQL]> = [];
  if (before && after && before.length === after.length) {
    bands.push([and(sql`${width} = ${before.length}`, sql`${id} < ${before}`, sql`${id} > ${after}`), sql`${id} DESC`]);
  } else if (!before || !after || before.length > after.length) {
    if (before) bands.push([and(sql`${width} = ${before.length}`, sql`${id} < ${before}`), sql`${id} DESC`]);
    bands.push([
      and(before ? sql`${width} < ${before.length}` : undefined, after ? sql`${width} > ${after.length}` : undefined),
      desc,
    ]);
    if (after) bands.push([and(sql`${width} = ${after.length}`, sql`${id} > ${after}`), sql`${id} DESC`]);
  }

  const rows: T[] = [];
  for (const [where, orderBy] of bands) {
    if (rows.length >= limit) break;
    rows.push(...await query(where, orderBy, limit - rows.length));
  }
  return rows;
}
