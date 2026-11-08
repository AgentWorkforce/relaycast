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
  return (searchIndex ?? new SqliteSearchIndex(db)).searchMessages({ ...opts, workspaceId });
}
