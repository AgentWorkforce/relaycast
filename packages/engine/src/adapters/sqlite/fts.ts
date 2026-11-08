/**
 * SQLite FTS5 statements for directory, routing and mention search.
 *
 * FTS5 virtual tables (`directory_agents_fts`, `directory_skills_fts`,
 * `messages_mention_fts`), `MATCH`, `bm25()` and the rowid joins onto them
 * exist only in the SQLite schema. Engine code builds these statements here
 * rather than inline; every function throws `UnsupportedOnPostgresError`
 * (`unsupported_on_postgres`) on a PostgreSQL handle. The PostgreSQL
 * equivalents (tsvector + GIN) belong to the search port.
 *
 * Statement text is kept byte-for-byte as it was written inline in the
 * engine, so SQLite behaviour is unchanged. bm25 ranks are ascending-is-better.
 */
import { sql, type SQL } from 'drizzle-orm';
import * as sqlx from '../../db/sqlx.js';

// --- directory search (engine/directory.ts) ---------------------------------

/** Per-row bm25 ranks of directory agents matching `ftsQuery` in a workspace. */
export function directoryAgentFtsRanks(db: sqlx.DialectSource, ftsQuery: string, workspaceId: string): SQL {
  sqlx.requireSqlite(db, 'directory agent full-text search');
  return sql`
        SELECT da.id AS directory_agent_id, bm25(directory_agents_fts) AS rank
        FROM directory_agents_fts
        JOIN directory_agents da ON da.rowid = directory_agents_fts.rowid
        WHERE directory_agents_fts MATCH ${ftsQuery}
          AND da.workspace_id = ${workspaceId}
      `;
}

/** Per-row bm25 ranks of directory skills matching `ftsQuery`, keyed by their directory agent. */
export function directorySkillFtsRanks(db: sqlx.DialectSource, ftsQuery: string, workspaceId: string): SQL {
  sqlx.requireSqlite(db, 'directory skill full-text search');
  return sql`
        SELECT ds.directory_agent_id AS directory_agent_id, bm25(directory_skills_fts) AS rank
        FROM directory_skills_fts
        JOIN directory_skills ds ON ds.rowid = directory_skills_fts.rowid
        JOIN directory_agents da ON da.id = ds.directory_agent_id
        WHERE directory_skills_fts MATCH ${ftsQuery}
          AND da.workspace_id = ${workspaceId}
      `;
}

// --- routing (engine/routing.ts) ---------------------------------------------

/**
 * Fragments that turn the `searchSkills` listing into an FTS-ranked search:
 * the rank column, the join onto `directory_skills_fts` (aliasing `ds`), the
 * MATCH predicate and the leading ORDER BY term.
 */
export function skillSearchFtsFragments(
  db: sqlx.DialectSource,
  ftsQuery: string,
): { rank: SQL; join: SQL; match: SQL; order: SQL } {
  sqlx.requireSqlite(db, 'skill full-text search');
  return {
    rank: sql`bm25(directory_skills_fts)`,
    join: sql`INNER JOIN directory_skills_fts ON directory_skills_fts.rowid = ds.rowid`,
    match: sql`AND directory_skills_fts MATCH ${ftsQuery}`,
    order: sql`bm25(directory_skills_fts) ASC,`,
  };
}

/** Per-row bm25 ranks of skills matching `ftsQuery`, for routing candidates. */
export function routingSkillFtsRanks(db: sqlx.DialectSource, ftsQuery: string, workspaceId: string): SQL {
  sqlx.requireSqlite(db, 'routing skill full-text search');
  return sql`
      SELECT ds.id AS skill_id, bm25(directory_skills_fts) AS rank
      FROM directory_skills_fts
      JOIN directory_skills ds ON ds.rowid = directory_skills_fts.rowid
      JOIN directory_agents da ON da.id = ds.directory_agent_id
      WHERE directory_skills_fts MATCH ${ftsQuery}
        AND da.workspace_id = ${workspaceId}
    `;
}

/** Per-row bm25 ranks of directory agents matching `ftsQuery`, for routing candidates. */
export function routingAgentFtsRanks(db: sqlx.DialectSource, ftsQuery: string, workspaceId: string): SQL {
  sqlx.requireSqlite(db, 'routing agent full-text search');
  return sql`
      SELECT da.id AS directory_agent_id, bm25(directory_agents_fts) AS rank
      FROM directory_agents_fts
      JOIN directory_agents da ON da.rowid = directory_agents_fts.rowid
      WHERE directory_agents_fts MATCH ${ftsQuery}
        AND da.workspace_id = ${workspaceId}
    `;
}

// --- mention index (engine/inbox.ts) -----------------------------------------

// The handle alphabet of `parseMessageMentions`.
const MENTION_HANDLE = /^[\w-]+$/;
// Tokens unicode61 actually indexes: `_` and `-` are separators, so a handle
// made only of those characters produces no FTS tokens.
const MENTION_FTS_TOKEN = /^[A-Za-z0-9]+$/;
// A shorter final token (`"1"*`, `"dev"*`) makes FTS walk a huge term range.
// Those handles keep the workspace scan, which still matches a trailing letter.
const MIN_FTS_PREFIX = 4;

/**
 * Workspace-scoped FTS5 MATCH for a canonical handle, or null when FTS cannot
 * represent it. The prefix is limited to the `body` column: an unscoped
 * `"1"*` also matches workspace snowflakes and returns every row. The last
 * token is a prefix so `@alice你好` (one unicode61 token) still matches
 * handle `alice`. Callers keep the `instr` and `parseMessageMentions` checks.
 */
function mentionFtsMatch(workspaceId: string, tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  if (!MENTION_HANDLE.test(workspaceId)) return null;
  if (tokens.some((token) => !MENTION_FTS_TOKEN.test(token))) return null;
  const last = tokens[tokens.length - 1] ?? '';
  if (last.length < MIN_FTS_PREFIX) return null;
  return `workspace_id : "${workspaceId}" AND body : "${tokens.join(' ')}"*`;
}

/**
 * A `messages` predicate restricting rows to `messages_mention_fts` candidates
 * for a handle's tokens, or null when FTS cannot represent the handle (the
 * caller keeps its workspace scan).
 */
export function mentionFtsCandidateFilter(
  db: sqlx.DialectSource,
  workspaceId: string,
  tokens: string[],
): SQL | null {
  sqlx.requireSqlite(db, 'mention full-text search');
  const mentionMatch = mentionFtsMatch(workspaceId, tokens);
  if (mentionMatch === null) return null;
  return sql`messages.rowid IN (SELECT rowid FROM messages_mention_fts WHERE messages_mention_fts MATCH ${sql.raw(`'${mentionMatch}'`)})`;
}

/** One rowid-keyed page of the mention backfill: row count and the page's last rowid. */
export function mentionFtsBackfillPage(
  db: sqlx.DialectSource,
  after: number,
  until: number,
  batchSize: number,
): SQL {
  sqlx.requireSqlite(db, 'mention full-text index backfill');
  return sql`
    SELECT count(*) AS copied, max(rowid) AS next_rowid FROM (
      SELECT rowid FROM messages
      WHERE rowid > ${after} AND rowid <= ${until}
      ORDER BY rowid
      LIMIT ${batchSize}
    )
  `;
}

/** Copy messages with rowid in (after, nextRowid] into `messages_mention_fts`, skipping indexed rows. */
export function mentionFtsBackfillInsert(db: sqlx.DialectSource, after: number, nextRowid: number): SQL {
  sqlx.requireSqlite(db, 'mention full-text index backfill');
  return sql`
    INSERT INTO messages_mention_fts(rowid, workspace_id, body)
    SELECT rowid, workspace_id, body FROM messages
    WHERE rowid > ${after} AND rowid <= ${nextRowid}
      AND NOT EXISTS (
        SELECT 1 FROM messages_mention_fts_docsize
        WHERE id = messages.rowid
      )
  `;
}
