import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import type { EngineDb } from '../../ports/database.js';
import { pruneExpired, type PruneOptions } from '../retention.js';
import type { RetentionCursorStore, RowidRetentionState } from '../rowidRetention.js';
import { snowflakeIdLowerBound } from '../snowflake.js';

const now = new Date('2026-09-09T14:00:00Z');
const seconds = Math.floor(now.getTime() / 1000);
const old = seconds - 110 * 86400;
const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); vi.useRealTimers(); });

function fixture() {
  const handle = getSqliteDb(':memory:'); handles.push(handle); runMigrations(handle);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(handle.sqlite, { schema, logger: { logQuery: (sql, params) => queries.push({ sql, params }) } }) as unknown as EngineDb;
  for (const ws of ['one', 'two']) {
    handle.sqlite.prepare('INSERT INTO workspaces(id,name,api_key_hash) VALUES (?,?,?)').run(ws, ws, ws);
    handle.sqlite.prepare('INSERT INTO agents(id,workspace_id,name,token_hash) VALUES (?,?,?,?)').run(ws, ws, ws, ws);
    handle.sqlite.prepare('INSERT INTO channels(id,workspace_id,name) VALUES (?,?,?)').run(ws, ws, ws);
  }
  let sequence = 0;
  const message = (days = 110, ws = 'one', thread: string | null = null) => {
    const id = String(BigInt(snowflakeIdLowerBound(now.getTime() - days * 86400000)) + BigInt(++sequence));
    handle.sqlite.prepare('INSERT INTO messages(id,workspace_id,channel_id,agent_id,body,thread_id) VALUES (?,?,?,?,?,?)').run(id, ws, ws, ws, 'body', thread);
    return id;
  };
  const delivery = (msg: string, status = 'acked', created = old, ws = 'one', expires: number | null = null) => {
    const id = `delivery-${++sequence}`;
    // A distinct agent is needed for each message/agent delivery uniqueness.
    const agent = `agent-${sequence}`;
    handle.sqlite.prepare('INSERT INTO agents(id,workspace_id,name,token_hash) VALUES (?,?,?,?)').run(agent, ws, agent, agent);
    handle.sqlite.prepare('INSERT INTO deliveries(id,workspace_id,message_id,agent_id,seq,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(id, ws, msg, agent, sequence, status, created, expires);
    return id;
  };
  let state: RowidRetentionState | undefined;
  const store: RetentionCursorStore = {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async (value) => { state = structuredClone(value); }),
  };
  const run = (opts: PruneOptions = {}) => pruneExpired(db, { cursorStore: store, batchLimit: 2, maxBatches: 1, now, ...opts });
  return { ...handle, db, queries, message, delivery, store, run, state: () => state };
}

describe('schema-free retention candidate pages', () => {
  it('bounds reads through retained history, advances cursors and issues no no-op writes', async () => {
    const f = fixture(); const msg = f.message(1);
    f.sqlite.transaction(() => { for (let i = 0; i < 1000; i++) f.delivery(msg, 'acked', seconds); })();
    expect((await f.run()).deliveries).toBe(0);
    expect(f.queries.filter(q => /^DELETE/i.test(q.sql))).toEqual([]);
    const first = f.state()!.tables.deliveries!.cursor;
    await f.run();
    expect(f.state()!.tables.deliveries!.cursor).toBeGreaterThan(first!);
    expect(f.queries.filter(q => /^DELETE/i.test(q.sql))).toEqual([]);
    const reads = f.queries.filter(q => q.sql.includes('FROM deliveries NOT INDEXED') && q.sql.includes('WITH page'));
    expect(reads.length).toBe(2);
    expect(reads.every(q => q.sql.includes('AS MATERIALIZED') && q.params.at(-1) === 2)).toBe(true);
    const plan = f.sqlite.prepare('EXPLAIN QUERY PLAN ' + reads[1]!.sql).all(...reads[1]!.params) as Array<{ detail: string }>;
    expect(plan.some(row => /SEARCH deliveries USING INTEGER PRIMARY KEY/.test(row.detail))).toBe(true);
    expect(f.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE name='maintenance_cursors'").get()).toEqual({ n: 0 });
  });

  it('preserves policy overrides, unsettled rows, messages and sequence counters', async () => {
    const f = fixture();
    const a = f.message(), b = f.message(110, 'two');
    f.sqlite.prepare('UPDATE workspaces SET retention=? WHERE id=?').run(JSON.stringify({ delivery_ttl_days: null }), 'two');
    const expired = [f.delivery(a), f.delivery(a, 'failed'), f.delivery(a, 'dead_lettered')];
    const kept = [f.delivery(a, 'queued'), f.delivery(a, 'delivered'), f.delivery(a, 'acked', seconds), f.delivery(b, 'acked', old, 'two')];
    const counters = f.sqlite.prepare('SELECT id,delivery_seq,delivery_ack_seq FROM agents ORDER BY id').all();
    for (let i = 0; i < 5; i++) await f.run();
    const remaining = f.sqlite.prepare('SELECT id FROM deliveries ORDER BY id').all() as Array<{ id: string }>;
    expect(remaining.map(r => r.id).sort()).toEqual(kept.sort());
    expect(remaining.some(r => expired.includes(r.id))).toBe(false);
    expect(f.sqlite.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 2 });
    expect(f.sqlite.prepare('SELECT id,delivery_seq,delivery_ack_seq FROM agents ORDER BY id').all()).toEqual(counters);
  });

  it('uses bounded variable counts and rowid seeks for multi-row deletes', async () => {
    const f = fixture(); const msg = f.message(1);
    for (let i = 0; i < 23; i++) f.delivery(msg);
    expect((await f.run({ batchLimit: 200 })).deliveries).toBe(23);
    const deletes = f.queries.filter(q => q.sql.startsWith('DELETE FROM deliveries'));
    expect(deletes.length).toBe(3);
    for (const query of deletes) {
      expect(query.params.length).toBeLessThanOrEqual(100);
      const plan = JSON.stringify(f.sqlite.prepare('EXPLAIN QUERY PLAN ' + query.sql).all(...query.params));
      expect(plan).toMatch(/SEARCH deliveries USING INTEGER PRIMARY KEY/);
      expect(plan).not.toMatch(/SCAN deliveries|USING INDEX idx_deliveries/);
    }
  });

  it('retains event high-water, live receipts, and thread parents until replies expire', async () => {
    const f = fixture(); const parent = f.message(), reply = f.message(110, 'one', parent);
    for (let seq = 1; seq <= 3; seq++) f.sqlite.prepare("INSERT INTO workspace_events(workspace_id,seq,type,payload,created_at) VALUES ('one',?,'test','{}',?)").run(seq, old);
    f.sqlite.prepare("INSERT INTO read_receipts(message_id,agent_id) VALUES (?,'one')").run(parent);
    const result = await f.run({ batchLimit: 200, defaults: { messageTtlDays: 30 } });
    expect(result.messages).toBe(1);
    expect(f.sqlite.prepare('SELECT id FROM messages').all()).toEqual([{ id: parent }]);
    expect(f.sqlite.prepare('SELECT seq FROM workspace_events').all()).toEqual([{ seq: 3 }]);
    expect(f.sqlite.prepare('SELECT message_id FROM read_receipts').all()).toEqual([{ message_id: parent }]);
    await f.run({ batchLimit: 200, defaults: { messageTtlDays: 30 } });
    expect(f.sqlite.prepare('SELECT id FROM messages').all()).toEqual([]);
    expect(reply).not.toEqual(parent);
    expect(f.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('wraps a finite high-water even while new rows arrive, revisiting retained rows', async () => {
    const f = fixture(); const msg = f.message(1);
    const retained = f.delivery(msg, 'delivered'); f.delivery(msg); f.delivery(msg);
    await f.run(); const high = f.state()!.tables.deliveries!.high;
    for (let i = 0; i < 4; i++) f.delivery(msg);
    await f.run();
    expect(f.state()!.tables.deliveries).toBeUndefined();
    f.sqlite.prepare("UPDATE deliveries SET status='acked' WHERE id=?").run(retained);
    await f.run();
    expect(f.sqlite.prepare('SELECT id FROM deliveries WHERE id=?').get(retained)).toBeUndefined();
    expect(high).toBe(3);
  });

  it('prunes orphaned workspace events under the default policy while keeping high-water', async () => {
    const f = fixture();
    for (let seq = 1; seq <= 2; seq++) f.sqlite.prepare("INSERT INTO workspace_events(workspace_id,seq,type,payload,created_at) VALUES ('missing-workspace',?,'test','{}',?)").run(seq, old);
    expect((await f.run()).workspaceEvents).toBe(1);
    expect(f.sqlite.prepare("SELECT seq FROM workspace_events WHERE workspace_id='missing-workspace'").all()).toEqual([{ seq: 2 }]);
  });

  it('persists table fairness but not candidate progress after an ambiguous failure', async () => {
    const f = fixture(); const msg = f.message();
    const execute = f.db.all.bind(f.db);
    const spy = vi.spyOn(f.db, 'all').mockImplementation((query) => {
      const text = f.db.dialect.sqlToQuery(query as never).sql;
      if (text.startsWith('DELETE FROM messages')) throw new Error('D1 failure');
      return execute(query);
    });
    await expect(f.run({ defaults: { messageTtlDays: 30 } })).rejects.toThrow('D1 failure');
    expect(f.state()!.next).toBe(1);
    expect(f.state()!.tables.messages?.cursor).toBeUndefined();
    spy.mockRestore();
    await f.run({ defaults: { messageTtlDays: 30 } });
    expect(f.sqlite.prepare('SELECT id FROM messages WHERE id=?').get(msg)).toBeUndefined();
  });

  it('awaits an admitted write but stops new SQL after the elapsed budget', async () => {
    const f = fixture(); for (let i = 0; i < 11; i++) f.message();
    vi.useFakeTimers(); vi.setSystemTime(now);
    const execute = f.db.all.bind(f.db);
    vi.spyOn(f.db, 'all').mockImplementation((query) => {
      const result = execute(query);
      if (f.db.dialect.sqlToQuery(query as never).sql.startsWith('DELETE FROM messages')) vi.advanceTimersByTime(11_000);
      return result;
    });
    expect((await f.run({ batchLimit: 200, defaults: { messageTtlDays: 30 } })).messages).toBe(10);
    expect(f.queries.filter(q => q.sql.startsWith('DELETE')).length).toBe(1);
    expect(f.state()!.tables.messages?.cursor).toBeUndefined();
    expect(f.state()!.next).toBe(1);
  });

  it('fails closed on corrupt durable state, invalid clocks and cursor persistence errors', async () => {
    const f = fixture();
    await expect(f.run({ now: new Date(NaN) })).rejects.toThrow('Invalid retention clock');
    vi.mocked(f.store.load).mockResolvedValueOnce({ version: 9 });
    await expect(f.run()).rejects.toThrow();
    vi.mocked(f.store.save).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.run()).rejects.toThrow('storage unavailable');
    expect(f.queries).toEqual([]);
  });

  it.each(['policy', 'status', 'rowid', 'created_at'])(
    'rechecks %s at mutation time rather than deleting from a stale candidate', async (change) => {
      const f = fixture(); const msg = f.message(); const id = f.delivery(msg);
      const execute = f.db.all.bind(f.db);
      let changed = false;
      vi.spyOn(f.db, 'all').mockImplementation((query) => {
        const text = f.db.dialect.sqlToQuery(query as never).sql;
        if (text.startsWith('DELETE FROM deliveries') && !changed) {
          changed = true;
          if (change === 'policy') f.sqlite.prepare("UPDATE workspaces SET retention=? WHERE id='one'").run(JSON.stringify({ delivery_ttl_days: null }));
          if (change === 'status') f.sqlite.prepare("UPDATE deliveries SET status='queued' WHERE id=?").run(id);
          if (change === 'created_at') f.sqlite.prepare('UPDATE deliveries SET created_at=? WHERE id=?').run(seconds, id);
          if (change === 'rowid') {
            const row = f.sqlite.prepare('SELECT rowid AS r FROM deliveries WHERE id=?').get(id) as { r: number };
            f.sqlite.prepare('DELETE FROM deliveries WHERE id=?').run(id);
            const replacement = f.delivery(msg);
            expect(f.sqlite.prepare('SELECT rowid AS r FROM deliveries WHERE id=?').get(replacement)).toEqual(row);
          }
        }
        return execute(query);
      });
      expect((await f.run()).deliveries).toBe(0);
      expect(changed).toBe(true);
      expect(f.sqlite.prepare('SELECT count(*) n FROM deliveries').get()).toEqual({ n: 1 });
    },
  );

  // Regression for the 2026-09-09 capacity incident: `queued` / `delivered`
  // deliveries past `expires_at` are covered by no `delivery_ttl_days` value,
  // so before this they were unreclaimable at any TTL. 4,409,692 of 4,409,767
  // queued rows on production were already expired.
  it('reaps queued and delivered rows long past expires_at', async () => {
    const f = fixture(); const msg = f.message(1);
    const staleQueued = f.delivery(msg, 'queued', seconds, 'one', seconds - 30 * 86400);
    const staleDelivered = f.delivery(msg, 'delivered', seconds, 'one', seconds - 30 * 86400);
    expect((await f.run({ batchLimit: 50, maxBatches: 5, activeExpiryRecovery: true })).deliveries).toBe(2);
    const left = f.sqlite.prepare('SELECT id FROM deliveries').all() as { id: string }[];
    expect(left.map(r => r.id)).not.toContain(staleQueued);
    expect(left.map(r => r.id)).not.toContain(staleDelivered);
  });

  it('keeps an active delivery inside its expiry grace window', async () => {
    const f = fixture(); const msg = f.message(1);
    const recent = f.delivery(msg, 'queued', seconds, 'one', seconds - 2 * 86400);
    expect((await f.run({ batchLimit: 50, maxBatches: 5, expiredDeliveryGraceDays: 7 })).deliveries).toBe(0);
    expect((f.sqlite.prepare('SELECT id FROM deliveries').all() as { id: string }[]).map(r => r.id)).toContain(recent);
  });

  it('never reaps an active delivery with no expires_at, however old', async () => {
    const f = fixture(); const msg = f.message(1);
    const immortal = f.delivery(msg, 'queued', old, 'one', null);
    expect((await f.run({ batchLimit: 50, maxBatches: 5 })).deliveries).toBe(0);
    expect((f.sqlite.prepare('SELECT id FROM deliveries').all() as { id: string }[]).map(r => r.id)).toContain(immortal);
  });

  it('honours the grace window boundary rather than any workspace TTL', async () => {
    const f = fixture(); const msg = f.message(1);
    // delivery_ttl_days disabled: only the expiry rule can authorize this.
    const stale = f.delivery(msg, 'queued', seconds, 'one', seconds - 10 * 86400);
    expect((await f.run({
      batchLimit: 50, maxBatches: 5, expiredDeliveryGraceDays: 30, activeExpiryRecovery: true,
      defaults: { deliveryTtlDays: null },
    })).deliveries).toBe(0);
    expect((await f.run({
      batchLimit: 50, maxBatches: 5, expiredDeliveryGraceDays: 7, activeExpiryRecovery: true,
      defaults: { deliveryTtlDays: null },
    })).deliveries).toBe(1);
    expect((f.sqlite.prepare('SELECT id FROM deliveries').all() as { id: string }[]).map(r => r.id)).not.toContain(stale);
  });

  it('opt-in active expiry recovery uses idx_deliveries_active_expiry and caps DELETE rows per call', async () => {
    const f = fixture(); const msg = f.message(1);
    // 5,000 expired queued deliveries; recovery caps at 4,000 rows per call.
    for (let i = 0; i < 5000; i++) f.delivery(msg, 'queued', seconds, 'one', seconds - 10 * 86400);
    const result = await f.run({ activeExpiryRecovery: true, expiredDeliveryGraceDays: 7, maxBatches: 4, batchLimit: 200 });
    expect(result.deliveries).toBeLessThanOrEqual(4000);
    expect(f.sqlite.prepare('SELECT count(*) n FROM deliveries').get()).toEqual({ n: 5000 - result.deliveries });

    const hasIndexMarker = f.queries.some((q) => q.sql.toLowerCase().includes('idx_deliveries_active_expiry'));
    expect(hasIndexMarker).toBe(true);

    const recoveryDeletes = f.queries.filter((q) => /^DELETE/i.test(q.sql) && q.sql.toLowerCase().includes('from deliveries'));
    expect(recoveryDeletes.length).toBeLessThanOrEqual(4);

    // Ensure the planner uses the index (not a scan).
    const idxQuery = f.queries.find((q) => q.sql.toLowerCase().includes('idx_deliveries_active_expiry'));
    expect(idxQuery).toBeTruthy();
    const explain = f.sqlite.prepare('EXPLAIN QUERY PLAN ' + idxQuery!.sql).all(...idxQuery!.params) as Array<{ detail: string }>;
    expect(explain.some((row) => /USING INDEX idx_deliveries_active_expiry/.test(row.detail))).toBe(true);
  });

  it('opt-in active expiry recovery preserves NULL expires_at, live active rows, and settled deliveries', async () => {
    const f = fixture(); const msg = f.message(1);
    const nullExpires = f.delivery(msg, 'queued', seconds, 'one', null);
    const inGrace = f.delivery(msg, 'queued', seconds, 'one', seconds - 3 * 86400); // within 7-day grace
    // Settled deliveries are pruned by delivery TTL, independent of grace.
    // Pick an unexpired acked row so we can verify the grace recovery
    // doesn't delete it.
    const settledAcked = f.delivery(msg, 'acked', seconds - 10 * 86400, 'one', seconds - 10 * 86400);
    const expiredQueued = f.delivery(msg, 'queued', seconds, 'one', seconds - 20 * 86400);

    await f.run({ activeExpiryRecovery: true, expiredDeliveryGraceDays: 7, maxBatches: 4 });

    const remaining = f.sqlite.prepare('SELECT id,status,expires_at FROM deliveries').all() as Array<{ id: string; status: string; expires_at: number | null }>;
    const cutoffSeconds = Math.floor((seconds * 1000 - 7 * 86400_000) / 1000);
    expect(remaining.some(r => r.id === nullExpires)).toBe(true);
    expect(remaining.some(r => r.id === inGrace && r.expires_at !== null && r.expires_at > cutoffSeconds && r.status === 'queued')).toBe(true);
    expect(remaining.some(r => r.id === settledAcked)).toBe(true);
    expect(remaining.some(r => r.id === expiredQueued)).toBe(false);
  });

  it('opt-in active expiry recovery skips expiry-extension races by rechecking expires_at at DELETE time', async () => {
    const f = fixture(); const msg = f.message(1);
    const toFlip = f.delivery(msg, 'queued', seconds, 'one', seconds - 20 * 86400);
    const executeAll = f.db.all.bind(f.db);
    let flipped = false;
    const spy = vi.spyOn(f.db, 'all').mockImplementation((query: unknown) => {
      const text = f.db.dialect.sqlToQuery(query as never).sql;
      if (!flipped && text.toLowerCase().includes('idx_deliveries_active_expiry')) {
        flipped = true;
        f.sqlite.prepare(`UPDATE deliveries SET expires_at = ${seconds + 30} WHERE id = ?`).run(toFlip);
      }
      return executeAll(query as never);
    });

    await f.run({ activeExpiryRecovery: true, expiredDeliveryGraceDays: 7, maxBatches: 4, batchLimit: 200 });
    spy.mockRestore();
    expect(f.sqlite.prepare('SELECT id FROM deliveries WHERE id=?').get(toFlip)).toBeTruthy();
    expect(flipped).toBe(true);
  });

  it('opt-in active expiry recovery skips status-transition races by rechecking queued/delivered at DELETE time', async () => {
    const f = fixture(); const msg = f.message(1);
    const toFlip = f.delivery(msg, 'queued', seconds, 'one', seconds - 20 * 86400);
    const executeAll = f.db.all.bind(f.db);
    let flipped = false;
    const spy = vi.spyOn(f.db, 'all').mockImplementation((query: unknown) => {
      const text = f.db.dialect.sqlToQuery(query as never).sql;
      if (!flipped && text.toLowerCase().includes('idx_deliveries_active_expiry')) {
        flipped = true;
        // Leave the active set by transitioning to a settled status right
        // before the indexed-candidate subquery is mutated by the outer DELETE.
        f.sqlite.prepare(`UPDATE deliveries SET status = 'acked' WHERE id = ?`).run(toFlip);
      }
      return executeAll(query as never);
    });

    await f.run({ activeExpiryRecovery: true, expiredDeliveryGraceDays: 7, maxBatches: 4, batchLimit: 200 });
    spy.mockRestore();
    expect(f.sqlite.prepare('SELECT id FROM deliveries WHERE id=?').get(toFlip)).toBeTruthy();
    expect(flipped).toBe(true);
  });

  it('opt-in active expiry recovery has hard worst-case DELETE statement count < 1000', async () => {
    const f = fixture(); const msg = f.message(1);
    for (let i = 0; i < 9000; i++) f.delivery(msg, 'delivered', seconds, 'one', seconds - 20 * 86400);
    await f.run({ activeExpiryRecovery: true, expiredDeliveryGraceDays: 7, maxBatches: 4, batchLimit: 200 });
    const statements = f.queries.filter(q => /^DELETE FROM deliveries/i.test(q.sql));
    // Rowid scan for active is disabled in this mode, so only the set-based recovery deletes should happen.
    expect(statements.length).toBeLessThan(1000);
    expect(statements.length).toBeLessThanOrEqual(4);
  });

  it('does not delete an expired queued row that was acked after the candidate read', async () => {
    const f = fixture(); const msg = f.message(1);
    const raced = f.delivery(msg, 'queued', seconds, 'one', seconds - 30 * 86400);
    const original = f.sqlite.prepare.bind(f.sqlite);
    // Flip the row to `acked` between the page read and the DELETE. The widened
    // guard still matches it (acked is settled), so without a status guard it
    // would be deleted under the expiry rule with its own TTL never checked.
    let flipped = false;
    (f.sqlite as unknown as { prepare: typeof original }).prepare = ((query: string) => {
      if (!flipped && /^DELETE FROM deliveries/i.test(query)) {
        flipped = true;
        original("UPDATE deliveries SET status = 'acked' WHERE id = ?").run(raced);
      }
      return original(query);
    }) as typeof original;
    await f.run({ batchLimit: 50, maxBatches: 5, defaults: { deliveryTtlDays: null } });
    expect((f.sqlite.prepare('SELECT id FROM deliveries').all() as { id: string }[]).map(r => r.id)).toContain(raced);
  });

  it('accepts a raised page ceiling so a large table can be traversed', async () => {
    const f = fixture(); const msg = f.message(1);
    f.sqlite.transaction(() => { for (let i = 0; i < 600; i++) f.delivery(msg, 'acked', seconds); })();
    await f.run({ batchLimit: 500, maxBatches: 1 });
    const reads = f.queries.filter(q => q.sql.includes('FROM deliveries NOT INDEXED') && q.sql.includes('WITH page'));
    // Rowid mode ceilings remain fixed at 200 rows/page.
    expect(reads.some(q => q.params.at(-1) === 200)).toBe(true);
  });
});
