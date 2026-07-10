/**
 * Typed keyset cursor abstraction (hardening item 3).
 *
 * The WorkspaceDO has a hard ~128MB cap per workspace. Any iteration
 * over the `files`, `events`, or `operations` tables MUST be
 * keyset-paginated with a SQL LIMIT — an unbounded SELECT pulls the
 * whole table into the isolate at once and OOMs the DO.
 *
 * After the P0 fix every existing query was bounded. This module is an
 * opt-in helper for new keyset-paginated reads. The automated guardrail is
 * the lint/grep gate (`scripts/check-do-unbounded-sql.mjs`), which rejects
 * new unbounded SELECTs in `packages/relayfile/src/durable-objects/**`.
 *
 * Usage:
 *
 *   const cursor = new KeysetCursor<FileRow, string>({
 *     fetchPage: ({ after, pageSize }) =>
 *       context.allRows<FileRow>(
 *         `SELECT ... FROM files
 *          ${after !== null ? "WHERE path > ?" : ""}
 *          ORDER BY path ASC
 *          LIMIT ?`,
 *         ...(after !== null ? [after] : []),
 *         pageSize,
 *       ),
 *     cursorOf: (row) => row.path,
 *     pageSize: 200,
 *   });
 *
 *   for await (const row of cursor) { ... }
 */

export interface KeysetCursorOptions<Row, Cursor> {
  /**
   * Fetch one page of rows starting strictly AFTER `after`. The caller
   * is responsible for writing the SQL with the right `WHERE col > ?
   * ORDER BY col ASC LIMIT ?` shape — the abstraction can't infer the
   * keyset column. A unit test in test/keyset-cursor.test.ts validates
   * that the SQL string includes `LIMIT`.
   */
  fetchPage: (input: {
    after: Cursor | null;
    pageSize: number;
  }) => Row[] | Promise<Row[]>;

  /** Project a row to its keyset cursor value. */
  cursorOf: (row: Row) => Cursor;

  /**
   * Default page size. Capped to {@link MAX_PAGE_SIZE} so an absent-
   * minded caller can't accidentally request the whole table.
   */
  pageSize?: number;
}

/**
 * Absolute cap on the page size for any keyset iteration. Mirrors
 * {@link MAX_LIST_ROWS} in adapter.ts and is duplicated here so the
 * cursor module is self-contained.
 */
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 200;

export class KeysetCursor<Row, Cursor> implements AsyncIterable<Row> {
  private readonly options: Required<
    Pick<KeysetCursorOptions<Row, Cursor>, "pageSize">
  > &
    KeysetCursorOptions<Row, Cursor>;

  constructor(options: KeysetCursorOptions<Row, Cursor>) {
    const pageSize = Math.max(
      1,
      Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    );
    this.options = { ...options, pageSize };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Row> {
    let after: Cursor | null = null;
    for (;;) {
      const rows = await this.options.fetchPage({
        after,
        pageSize: this.options.pageSize,
      });
      if (rows.length === 0) return;
      for (const row of rows) {
        after = this.options.cursorOf(row);
        yield row;
      }
      if (rows.length < this.options.pageSize) return;
    }
  }

  /**
   * Convenience: drain the cursor into an array up to `limit` rows.
   * Useful in handler code that wants the first N rows without writing
   * a manual for-await loop.
   */
  async take(limit: number): Promise<Row[]> {
    if (limit <= 0) {
      return [];
    }
    const out: Row[] = [];
    for await (const row of this) {
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }
}

/**
 * Type-narrowed factory for the files table. Encodes the right SQL
 * shape so the caller can't accidentally drop the LIMIT.
 *
 * The `selectColumns` parameter is comma-joined into the SELECT — keep
 * it literal (no user input) since this is interpolated raw into SQL.
 */
export function filesKeysetCursor<Row>(args: {
  allRows: <T>(query: string, ...bindings: unknown[]) => T[];
  toRow: (raw: Record<string, unknown>) => Row;
  selectColumns: string;
  pageSize?: number;
}): KeysetCursor<Row, string> {
  return new KeysetCursor<Row, string>({
    fetchPage: ({ after, pageSize }) => {
      const bindings: unknown[] = [];
      const where = after !== null ? "WHERE path > ?" : "";
      if (after !== null) bindings.push(after);
      bindings.push(pageSize);
      const rows = args.allRows<Record<string, unknown>>(
        `
          SELECT ${args.selectColumns}
          FROM files
          ${where}
          ORDER BY path ASC
          LIMIT ?
        `,
        ...bindings,
      );
      return rows.map(args.toRow);
    },
    cursorOf: (row) => (row as unknown as { path: string }).path,
    pageSize: args.pageSize,
  });
}

/**
 * Same shape for events, keyed on (timestamp ASC, event_id ASC) — the feed
 * is a forward watermark, so each page returns events newer than the cursor.
 * The cursor here is the last (newest) event_id we returned; the caller's
 * fetchPage must resolve it to (timestamp, event_id) — events
 * pagination is the only one of the three where a single column isn't
 * enough on its own (two events can share a timestamp).
 */
export function eventsKeysetCursor<Row>(args: {
  fetchPage: (input: { after: string | null; pageSize: number }) => Row[];
  cursorOf: (row: Row) => string;
  pageSize?: number;
}): KeysetCursor<Row, string> {
  return new KeysetCursor<Row, string>(args);
}

/**
 * Operations cursor keyed on op_id (op_id is monotonically allocated
 * via nextId("op") in the DO so it's safe as a sort key).
 */
export function operationsKeysetCursor<Row>(args: {
  allRows: <T>(query: string, ...bindings: unknown[]) => T[];
  toRow: (raw: Record<string, unknown>) => Row;
  selectColumns: string;
  pageSize?: number;
}): KeysetCursor<Row, string> {
  return new KeysetCursor<Row, string>({
    fetchPage: ({ after, pageSize }) => {
      const bindings: unknown[] = [];
      const where = after !== null ? "WHERE op_id < ?" : "";
      if (after !== null) bindings.push(after);
      bindings.push(pageSize);
      const rows = args.allRows<Record<string, unknown>>(
        `
          SELECT ${args.selectColumns}
          FROM operations
          ${where}
          ORDER BY op_id DESC
          LIMIT ?
        `,
        ...bindings,
      );
      return rows.map(args.toRow);
    },
    cursorOf: (row) => (row as unknown as { opId: string }).opId,
    pageSize: args.pageSize,
  });
}
