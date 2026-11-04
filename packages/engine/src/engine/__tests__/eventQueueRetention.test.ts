import { afterEach, expect, it, vi } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { cleanupOldEvents } from '../eventQueue.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

it('seeks the settlement cutoff and counts ids without materializing expired payloads', async () => {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const sqlite = handle.sqlite;
  sqlite.exec("INSERT INTO workspaces(id,name,api_key_hash) VALUES('retention','retention','retention-key')");
  const now = Math.floor(Date.now() / 1000);
  const expired = now - 172800;
  const insert = sqlite.prepare(`INSERT INTO pending_events
    (id,workspace_id,event_type,payload,status,completed_at) VALUES (?,'retention','message.created',?,?,?)`);
  sqlite.transaction(() => {
    for (let index = 0; index < 1000; index++) {
      insert.run(`recent_${index}`, '{"keep":true}', index % 2 ? 'completed' : 'failed', now);
    }
    for (let index = 0; index < 500; index++) {
      // Counting deleted events must not depend on decoding their payloads.
      insert.run(`expired_${index}`, 'legacy-invalid-json', index % 2 ? 'completed' : 'failed', expired);
    }
    insert.run('pending_old', '{}', 'pending', expired);
    insert.run('completed_unsettled', '{}', 'completed', null);
  })();
  sqlite.exec(`INSERT INTO event_subscriptions(id,workspace_id,events,url)
    VALUES('retention_sub','retention','["message.created"]','https://example.com/hook');
    INSERT INTO webhook_deliveries(id,event_id,subscription_id)
    VALUES('expired_child','expired_0','retention_sub'),('recent_child','recent_0','retention_sub')`);
  const prepare = vi.spyOn(sqlite, 'prepare');
  expect(await cleanupOldEvents(handle.db)).toBe(500);
  const deletion = prepare.mock.calls.map(([source]) => source).find(source => /^delete from "pending_events"/.test(source));
  expect(deletion).toBeDefined();
  expect(deletion).toMatch(/returning "id"$/);
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${deletion}`).all('completed', 'failed', now - 86400) as Array<{ detail: string }>;
  expect(plan.some(row => /idx_pending_events_settled_retention.*status=\?.*completed_at</.test(row.detail))).toBe(true);
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM pending_events').get()).toEqual({ n: 1002 });
  expect(sqlite.prepare('SELECT id FROM webhook_deliveries').all()).toEqual([{ id: 'recent_child' }]);
  expect(await cleanupOldEvents(handle.db)).toBe(0);
});
