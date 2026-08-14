/**
 * Cloudflare D1 permits at most 100 bound parameters in one statement. Keep a
 * little headroom for predicates outside an IN clause (agent id, workspace id,
 * status, and future additions) instead of coupling a query to the exact cap.
 */
export const D1_SAFE_IN_QUERY_CHUNK_SIZE = 90;

/** Run an IN-based lookup in D1-safe chunks and preserve every returned row. */
export async function queryInChunks<TValue, TRow>(
  values: readonly TValue[],
  query: (chunk: TValue[]) => PromiseLike<TRow[]> | TRow[],
  chunkSize = D1_SAFE_IN_QUERY_CHUNK_SIZE,
): Promise<TRow[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('chunkSize must be a positive integer');
  }

  const rows: TRow[] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    rows.push(...await query(values.slice(index, index + chunkSize)));
  }
  return rows;
}
