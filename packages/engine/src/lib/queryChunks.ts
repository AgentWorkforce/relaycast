/**
 * Cloudflare D1 permits at most 100 bound parameters in one statement. Keep a
 * little headroom for predicates outside an IN clause (agent id, workspace id,
 * status, and future additions) instead of coupling a query to the exact cap.
 */
export const D1_SAFE_IN_QUERY_CHUNK_SIZE = 90;

/**
 * Split values into D1-safe IN-list chunks. Writes that must stay atomic build
 * one statement per chunk and run them all in a single batch.
 */
export function chunkValues<TValue>(
  values: readonly TValue[],
  chunkSize = D1_SAFE_IN_QUERY_CHUNK_SIZE,
): TValue[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError('chunkSize must be a positive integer');
  }

  const chunks: TValue[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

/** Run an IN-based lookup in D1-safe chunks and preserve every returned row. */
export async function queryInChunks<TValue, TRow>(
  values: readonly TValue[],
  query: (chunk: TValue[]) => PromiseLike<TRow[]> | TRow[],
  chunkSize = D1_SAFE_IN_QUERY_CHUNK_SIZE,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (const chunk of chunkValues(values, chunkSize)) {
    rows.push(...await query(chunk));
  }
  return rows;
}
