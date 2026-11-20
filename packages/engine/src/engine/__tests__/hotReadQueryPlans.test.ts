import { afterEach, describe, expect, it } from 'vitest';
import { brandSqliteEngineDb } from '../../adapters/sqlite-handle.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/tables.js';
import { configureNodeLiveness } from '../nodeLiveness.js';
import { prepareAuthorityFanout } from '../deliveryWrites.js';
import { latestMessageIdsByChannel } from '../dmAll.js';
import { fetchAttachmentsBatch } from '../attachments.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

// No ANALYZE, like production D1: plans must not depend on table statistics.
function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES ('node','ws','node','node-token');
    INSERT INTO channels(id,workspace_id,name,channel_type) VALUES ('channel','ws','general',0), ('dm-channel','ws','dm',1);
    INSERT INTO dm_conversations(id,workspace_id,channel_id,dm_type) VALUES ('dm','ws','dm-channel','group');
  `);
  const agent = sqlite.prepare(`INSERT INTO agents(id,workspace_id,name,token_hash,location_type,location_node_id) VALUES (?,'ws',?,?,'via_node','node')`);
  const message = sqlite.prepare(`INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES (?,'ws',?,'agent-0','body')`);
  const file = sqlite.prepare(`INSERT INTO files(id,workspace_id,uploaded_by,filename,content_type,size_bytes,storage_key) VALUES (?,'ws','agent-0','f','text/plain',1,?)`);
  sqlite.transaction(() => {
    // A roster far larger than the audience.
    for (let n = 0; n < 2_000; n++) agent.run('agent-' + n, 'agent-' + n, 'token-' + n);
    for (let n = 0; n < 5; n++) {
      sqlite.prepare(`INSERT INTO channel_members(channel_id,agent_id) VALUES ('channel',?)`).run('agent-' + n);
      sqlite.prepare(`INSERT INTO dm_participants(conversation_id,agent_id) VALUES ('dm',?)`).run('agent-' + n);
    }
    for (let n = 0; n < 2_000; n++) message.run('m' + String(n).padStart(5, '0'), n % 2 ? 'channel' : 'dm-channel');
    for (let n = 0; n < 1_000; n++) file.run('file-' + n, 'key-' + n);
    sqlite.exec(`INSERT INTO message_attachments(message_id,file_id,position) VALUES ('m00001','file-1',0)`);
  })();
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = brandSqliteEngineDb(drizzle(sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }));
  const plan = (match: (sql: string) => boolean) => {
    const query = queries.find(q => match(q.sql))!;
    return (sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params) as { detail: string }[]).map(row => row.detail);
  };
  return { db, plan };
}

describe('hot read query plans without planner statistics', () => {
  it('drives authority fanout from the audience instead of the workspace roster', async () => {
    const f = fixture();
    configureNodeLiveness(f.db, { inspect: async () => ({ status: 'unknown', providers: [] }) });
    expect(await prepareAuthorityFanout(f.db, 'ws', { channelId: 'channel' })).toHaveLength(5);
    expect(await prepareAuthorityFanout(f.db, 'ws', { conversationId: 'dm' })).toHaveLength(5);
    for (const [table, key] of [['channel_members', 'channel_id'], ['dm_participants', 'conversation_id']]) {
      const plan = f.plan(sql => sql.includes('"nodes"') && sql.includes(`from "${table}"`));
      expect(plan[0]).toMatch(new RegExp(`^SEARCH ${table} USING COVERING INDEX \\S+ \\(${key}=\\?\\)$`));
      expect(plan.slice(1).join('\n')).toMatch(/^SEARCH agents USING INDEX \S+ \((workspace_id=\? AND )?id=\?\)\nSEARCH nodes /);
    }
  });

  it('reads one index entry per channel for the latest DM message', async () => {
    const f = fixture();
    expect(await latestMessageIdsByChannel(f.db, ['channel', 'dm-channel', 'missing']))
      .toEqual([{ channelId: 'channel', lastId: 'm01999' }, { channelId: 'dm-channel', lastId: 'm01998' }]);
    const plan = f.plan(sql => sql.includes('"messages"'));
    // A correlated ORDER BY id DESC LIMIT 1 seek; no aggregate walks the channel.
    expect(plan).toEqual([
      expect.stringMatching(/^SEARCH channels USING .*\(id=\?\)$/),
      'CORRELATED SCALAR SUBQUERY 1',
      'SEARCH m USING COVERING INDEX idx_messages_channel_time (channel_id=?)',
    ]);
  });

  it('seeks attachments by message id instead of probing every workspace file', async () => {
    const f = fixture();
    // A page-sized id list (production averages ~46); short lists already seek.
    const page = Array.from({ length: 46 }, (_, n) => 'm' + String(n).padStart(5, '0'));
    const attachments = await fetchAttachmentsBatch(f.db, 'ws', page);
    expect([...attachments.keys()]).toEqual(['m00001']);
    const plan = f.plan(sql => sql.includes('message_attachments'));
    expect(plan[0]).toMatch(/^SEARCH message_attachments USING INDEX \S+ \(message_id=\?\)$/);
    expect(plan[1]).toMatch(/^SEARCH files USING INDEX \S+ \(id=\?\)$/);
    expect(plan.join('\n')).not.toContain('idx_files_workspace');
  });
});
