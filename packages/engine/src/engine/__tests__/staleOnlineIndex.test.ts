import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/**
 * The cloud maintenance sweep `reconcileStaleOnlineNodes` finds `online`
 * nodes whose heartbeat lapsed — globally, across workspaces. Every nodes
 * index leads with workspace_id, so production answers this with a full
 * table scan (~24k rows) per cron tick on the database whose overload the
 * sweep exists to relieve. The fixture keeps a small online subset around a
 * large offline one so the plan difference is unmistakable.
 */
const RECONCILE_CANDIDATE_SCAN = `
  SELECT id, workspace_id FROM nodes
  WHERE status = 'online'
    AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)
  LIMIT ?`;

function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key')`);
  const insert = sqlite.prepare(
    `INSERT INTO nodes(id,workspace_id,name,token_hash,role,status,last_heartbeat_at) VALUES (?,?,?,?,?,?,?)`,
  );
  sqlite.transaction(() => {
    for (let n = 0; n < 5_000; n++) {
      insert.run(`off-${n}`, 'ws', `off-${n}`, `tok-off-${n}`, 'broker', 'offline', null);
    }
    for (let n = 0; n < 20; n++) {
      insert.run(`stale-${n}`, 'ws', `stale-${n}`, `tok-stale-${n}`, 'broker', 'online', 1000);
    }
    for (let n = 0; n < 10; n++) {
      insert.run(`live-${n}`, 'ws', `live-${n}`, `tok-live-${n}`, 'broker', 'online', 9_999_999_999);
    }
  })();
  return { sqlite };
}

describe('stale online node reconcile scan', () => {
  it('answers from the online-only index instead of scanning every node row', () => {
    const { sqlite } = fixture();
    const plan = JSON.stringify(sqlite.prepare(`EXPLAIN QUERY PLAN ${RECONCILE_CANDIDATE_SCAN}`).all(5_000_000, 25));
    expect(plan).toContain('idx_nodes_online_liveness');
    expect(plan).not.toMatch(/"detail":"SCAN nodes"/);
  });

  it('still finds exactly the stale online rows', () => {
    const { sqlite } = fixture();
    const rows = sqlite.prepare(RECONCILE_CANDIDATE_SCAN).all(5_000_000, 25) as { id: string }[];
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.id.startsWith('stale-'))).toBe(true);
  });
});
