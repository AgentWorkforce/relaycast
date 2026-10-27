import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import { getThread } from '../thread.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key'), ('other','other','other-key');
    INSERT INTO agents(id,workspace_id,name,token_hash) VALUES ('agent','ws','author','token'), ('other-agent','other','other','other-token');
    INSERT INTO channels(id,workspace_id,name) VALUES ('channel','ws','general'), ('other-channel','other','other');
    INSERT INTO messages(id,workspace_id,channel_id,agent_id,body,created_at)
      VALUES ('parent','ws','channel','agent','parent',1700000000);
  `);
  const message = sqlite.prepare(`INSERT INTO messages(id,workspace_id,channel_id,agent_id,body,thread_id,blocks,metadata,created_at)
    VALUES (?,'ws','channel','agent','reply',?,?,?,1700000000)`);
  sqlite.transaction(() => {
    for (let n = 0; n < 10_000; n++) message.run('history-' + n, null, null, null);
    for (const id of ['reply-1', 'reply-2', 'reply-3']) {
      message.run(id, 'parent', JSON.stringify([{ type: 'section', text: 'hello' }]), JSON.stringify({ source: 'test' }));
    }
  })();
  // Keep the workspace predicate meaningful even for a malformed historical row.
  sqlite.exec(`INSERT INTO messages(id,workspace_id,channel_id,agent_id,body,thread_id)
    VALUES ('reply-foreign','other','other-channel','other-agent','foreign','parent')`);
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }) as unknown as EngineDb;
  return { sqlite, db, queries };
}

describe('thread reads with retained workspace history', () => {
  it('seeks only the requested thread without a workspace-wide scan or sort', async () => {
    const f = fixture();
    const result = await getThread(f.db, 'ws', 'parent', { after: 'reply-1', before: 'reply-foreign', limit: 1 });
    expect(result.replies).toEqual([expect.objectContaining({
      id: 'reply-2', agent_name: 'author', has_attachments: false,
      blocks: [{ type: 'section', text: 'hello' }], metadata: { source: 'test' },
      created_at: '2023-11-14T22:13:20.000Z',
    })]);
    const query = f.queries.find(q => q.sql.includes('left join') && q.sql.includes('order by'))!;
    const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
    expect(plan).toContain('SEARCH messages USING INDEX idx_messages_thread');
    expect(plan).not.toContain('idx_messages_workspace');
    expect(plan).not.toContain('USE TEMP B-TREE');
    expect((await getThread(f.db, 'ws', 'parent')).replies.map(r => r.id)).toEqual(['reply-1', 'reply-2', 'reply-3']);
    await expect(getThread(f.db, 'other', 'parent')).rejects.toMatchObject({ code: 'message_not_found' });
  });
});
