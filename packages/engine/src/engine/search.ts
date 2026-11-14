import type { EngineDb } from '../ports/database.js';
import type { MessageSearchOptions, SearchIndex } from '../ports/search.js';
import { SqliteSearchIndex } from '../adapters/sqlite/search.js';
import { PostgresSearchIndex, isPostgresEngineDb } from '../adapters/postgres/search.js';

/** Preserve the existing direct-call API while hosts can supply a search adapter. */
export async function searchMessages(
  db: EngineDb,
  workspaceId: string,
  opts: MessageSearchOptions,
  searchIndex?: SearchIndex,
) {
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  const index = searchIndex ?? (isPostgresEngineDb(db) ? new PostgresSearchIndex(db) : new SqliteSearchIndex(db));
  const results = await index.searchMessages({ ...opts, limit, workspaceId });
  // Storage scoping is mandatory, but a buggy adapter must not expose rows from
  // another workspace through ordinary tokens or observer-token filtering.
  if (results.some((result) => result.workspace_id !== workspaceId)) {
    throw new Error('Search adapter returned a result outside the authenticated workspace');
  }
  return results;
}
