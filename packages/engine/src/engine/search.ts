import type { EngineDb } from '../ports/database.js';
import type { MessageSearchOptions, SearchIndex } from '../ports/search.js';
import { SqliteSearchIndex } from '../adapters/sqlite/search.js';

/** Preserve the existing direct-call API while hosts can supply a search adapter. */
export async function searchMessages(
  db: EngineDb,
  workspaceId: string,
  opts: MessageSearchOptions,
  searchIndex?: SearchIndex,
) {
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  return (searchIndex ?? new SqliteSearchIndex(db)).searchMessages({ ...opts, limit, workspaceId });
}
