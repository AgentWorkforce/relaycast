import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import * as schema from '../../db/schema.js';
import {
  pruneExpired,
  sweepDueNodeDeliveries,
  type PruneOptions,
  type RetentionCursorStore,
  type RowidRetentionState,
} from '../../index.js';
import type { EngineDb } from '../../ports/database.js';

const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); vi.restoreAllMocks(); });

function fixture() {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  handle.sqlite.exec(`
    INSERT INTO workspaces(id, name, api_key_hash) VALUES ('ws', 'workspace', 'key');
    INSERT INTO agents(id, workspace_id, name, token_hash) VALUES ('agent', 'ws', 'agent', 'token');
    INSERT INTO channels(id, workspace_id, name) VALUES ('channel', 'ws', 'general');
  `);
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(handle.sqlite, {
    schema,
    logger: { logQuery: (sql, params) => queries.push({ sql, params }) },
  }) as unknown as EngineDb;
  let state: RowidRetentionState | undefined;
  const cursorStore: RetentionCursorStore = {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async (next) => { state = structuredClone(next); }),
  };
  return { ...handle, db, queries, cursorStore, state: () => state };
}

// This is deliberately the exact public shape used by relaycast-cloud's
// scheduledMaintenance entrypoint. It protects the engine package boundary
// without importing or modifying the cloud repository.
function scheduledMaintenanceCallShape(cursorStore: RetentionCursorStore) {
  const retention = {
    batchLimit: 200,
    maxBatches: 5,
    defaults: { messageTtlDays: 30 },
    cursorStore,
    maxDurationMs: 10_000,
  } satisfies PruneOptions;
  const redrive = {
    limit: 50,
    wsBacklogLimit: 25,
  } satisfies NonNullable<Parameters<typeof sweepDueNodeDeliveries>[1]>;
  return { retention, redrive };
}

describe('scheduled-maintenance API compatibility', () => {
  it('accepts the current cloud retention and redrive call shape', () => {
    const { cursorStore } = fixture();
    expect(scheduledMaintenanceCallShape(cursorStore)).toMatchObject({
      retention: { cursorStore, maxDurationMs: 10_000 },
      redrive: { limit: 50, wsBacklogLimit: 25 },
    });
  });

  it('uses the host cursor store for bounded, resumable retention without touching maintenance_cursors', async () => {
    const f = fixture();
    const old = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1_000);
    const message = f.sqlite.prepare("INSERT INTO messages(id, workspace_id, channel_id, agent_id, body) VALUES (?, 'ws', 'channel', 'agent', 'body')");
    const delivery = f.sqlite.prepare("INSERT INTO deliveries(id, workspace_id, message_id, agent_id, seq, status, created_at) VALUES (?, 'ws', ?, 'agent', ?, 'acked', ?)");
    for (let n = 1; n <= 5; n++) {
      const id = String(n);
      message.run(id);
      delivery.run('delivery-' + id, id, n, old);
    }

    const opts: PruneOptions = {
      cursorStore: f.cursorStore,
      batchLimit: 2,
      maxBatches: 1,
      now: new Date('2026-06-01T00:00:00Z'),
    };
    await pruneExpired(f.db, opts);
    expect(f.state()?.tables.deliveries?.cursor).toBeDefined();
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM maintenance_cursors WHERE id = 'retention-v1'").get()).toEqual({ n: 0 });
    expect(f.queries.some(query => query.sql.includes('FROM deliveries NOT INDEXED') && query.sql.includes('WITH page AS MATERIALIZED'))).toBe(true);

    await pruneExpired(f.db, opts);
    await pruneExpired(f.db, opts);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    expect(vi.mocked(f.cursorStore.save)).toHaveBeenCalled();
  });

  it.each([
    {},
    { version: 1 },
    { next: 0, positions: {}, highs: {} },
    { version: 1, next: 0, tables: { deliveries: { cursor: 'legacy-rowid' } } },
  ])('resets malformed host cursor state safely: %j', async (saved) => {
    const f = fixture();
    const old = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1_000);
    f.sqlite.exec(`
      INSERT INTO messages(id, workspace_id, channel_id, agent_id, body)
        VALUES ('message', 'ws', 'channel', 'agent', 'body');
      INSERT INTO deliveries(id, workspace_id, message_id, agent_id, seq, status, created_at)
        VALUES ('delivery', 'ws', 'message', 'agent', 1, 'acked', ${old});
    `);
    vi.mocked(f.cursorStore.load).mockResolvedValue(saved);

    await expect(pruneExpired(f.db, {
      cursorStore: f.cursorStore,
      batchLimit: 2,
      maxBatches: 1,
      now: new Date('2026-06-01T00:00:00Z'),
    })).resolves.toMatchObject({ deliveries: 1 });
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    expect(vi.mocked(f.cursorStore.save)).toHaveBeenCalled();
    expect(f.state()).toMatchObject({ version: 1, tables: {} });
  });

  it('reclaims long-expired active deliveries only when explicitly enabled', async () => {
    const f = fixture();
    const now = new Date('2026-06-01T00:00:00Z');
    const expired = Math.floor(now.getTime() / 1_000) - 8 * 86_400;
    f.sqlite.exec(`
      INSERT INTO messages(id, workspace_id, channel_id, agent_id, body) VALUES ('message', 'ws', 'channel', 'agent', 'body');
      INSERT INTO deliveries(id, workspace_id, message_id, agent_id, seq, status, expires_at)
      VALUES ('queued', 'ws', 'message', 'agent', 1, 'queued', ${expired});
    `);

    await expect(pruneExpired(f.db, {
      cursorStore: f.cursorStore,
      activeExpiryRecovery: true,
      expiredDeliveryGraceDays: 7,
      maxBatches: 1,
      now,
    })).resolves.toMatchObject({ deliveries: 1 });
    expect(f.sqlite.prepare("SELECT id FROM deliveries WHERE id = 'queued'").get()).toBeUndefined();
    expect(f.queries.some(query => query.sql.includes('idx_deliveries_active_expiry'))).toBe(true);
  });
});
