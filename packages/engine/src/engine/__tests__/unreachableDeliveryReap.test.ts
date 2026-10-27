import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import {
  agents,
  channels,
  deliveries,
  messages,
  nodes,
  workspaces,
} from '../../db/schema.js';
import {
  deadLetterUnreachableDeliveryBatch,
  UNREACHABLE_NODE_GRACE_MS,
} from '../delivery.js';

type Db = SqliteDbHandle['db'];

const handles: SqliteDbHandle[] = [];
function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

let seq = 0;

interface Seeded { ws: string; ch: string; sender: string; target: string; targetName: string }

async function seed(db: Db): Promise<Seeded> {
  const n = ++seq;
  const ws = `ws_${n}`;
  await db.insert(workspaces).values({ id: ws, name: `w${n}`, apiKeyHash: `hash_${n}` });
  const ch = `ch_${n}`;
  await db.insert(channels).values({ id: ch, workspaceId: ws, name: 'general' });
  const sender = `sender_${n}`;
  const target = `target_${n}`;
  const targetName = `target${n}`;
  await db.insert(agents).values([
    { id: sender, workspaceId: ws, name: `sender${n}`, tokenHash: `tok_s${n}` },
    { id: target, workspaceId: ws, name: targetName, tokenHash: `tok_t${n}` },
  ]);
  return { ws, ch, sender, target, targetName };
}

async function insertNode(
  db: Db,
  ws: string,
  status: string,
  lastHeartbeatAt: Date | null,
  kind: string = 'ws',
): Promise<string> {
  const n = ++seq;
  const id = `node_${n}`;
  await db.insert(nodes).values({
    id,
    workspaceId: ws,
    name: `node${n}`,
    tokenHash: `ntok_${n}`,
    kind,
    status,
    lastHeartbeatAt,
  });
  return id;
}

async function insertQueuedDelivery(
  db: Db,
  base: Seeded,
  locationNodeId: string | null,
): Promise<string> {
  const n = ++seq;
  const messageId = `msg_${n}`;
  await db.insert(messages).values({
    id: messageId,
    workspaceId: base.ws,
    channelId: base.ch,
    agentId: base.sender,
    body: `body ${n}`,
  });
  const id = `del_${n}`;
  await db.insert(deliveries).values({
    id,
    workspaceId: base.ws,
    messageId,
    agentId: base.target,
    status: 'queued',
    seq: n,
    locationType: 'via_node',
    locationNodeId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return id;
}

async function deliveryStatus(db: Db, id: string): Promise<{ status: string; error: string | null }> {
  const [row] = await db
    .select({ status: deliveries.status, error: deliveries.error })
    .from(deliveries)
    .where(eq(deliveries.id, id));
  return row;
}

describe('deadLetterUnreachableDeliveryBatch', () => {
  it('dead-letters queued deliveries routed to a long-offline node and reports sender notices', async () => {
    const { db } = openDb();
    const base = await seed(db);
    const now = new Date();
    const deadNode = await insertNode(db, base.ws, 'offline', new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 60_000));
    const deliveryId = await insertQueuedDelivery(db, base, deadNode);

    const batch = await deadLetterUnreachableDeliveryBatch(db, base.ws, UNREACHABLE_NODE_GRACE_MS, now);

    expect(batch.expiredCount).toBe(1);
    expect(await deliveryStatus(db, deliveryId)).toEqual({
      status: 'dead_lettered',
      error: 'target node unreachable',
    });
    expect(batch.notices).toEqual([
      expect.objectContaining({
        workspace_id: base.ws,
        delivery_id: deliveryId,
        sender_agent_id: base.sender,
        target_agent_id: base.target,
        target_agent_name: base.targetName,
        reason: 'node_unreachable',
        retryable: false,
      }),
    ]);
  });

  it('leaves deliveries alone when their node is online, freshly offline, or never heartbeated', async () => {
    const { db } = openDb();
    const base = await seed(db);
    const now = new Date();
    const onlineNode = await insertNode(db, base.ws, 'online', now);
    const freshOffline = await insertNode(db, base.ws, 'offline', new Date(now.getTime() - 60_000));
    const neverLive = await insertNode(db, base.ws, 'offline', null);

    const kept = [
      await insertQueuedDelivery(db, base, onlineNode),
      await insertQueuedDelivery(db, base, freshOffline),
      await insertQueuedDelivery(db, base, neverLive),
      await insertQueuedDelivery(db, base, null),
    ];

    const batch = await deadLetterUnreachableDeliveryBatch(db, base.ws, UNREACHABLE_NODE_GRACE_MS, now);
    expect(batch.expiredCount).toBe(0);
    expect(batch.notices).toEqual([]);
    for (const id of kept) {
      expect((await deliveryStatus(db, id)).status).toBe('queued');
    }
  });

  it('does not touch already-settled deliveries on dead nodes', async () => {
    const { db } = openDb();
    const base = await seed(db);
    const now = new Date();
    const deadNode = await insertNode(db, base.ws, 'offline', new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 60_000));
    const ackedId = await insertQueuedDelivery(db, base, deadNode);
    await db.update(deliveries).set({ status: 'acked' }).where(eq(deliveries.id, ackedId));

    const batch = await deadLetterUnreachableDeliveryBatch(db, base.ws, UNREACHABLE_NODE_GRACE_MS, now);
    expect(batch.expiredCount).toBe(0);
    expect((await deliveryStatus(db, ackedId)).status).toBe('acked');
  });

  it('leaves deliveries on http_push and poll nodes alone — no socket liveness contract', async () => {
    const { db } = openDb();
    const base = await seed(db);
    const now = new Date();
    const stale = new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 60_000);
    const pushNode = await insertNode(db, base.ws, 'offline', stale, 'http_push');
    const pollNode = await insertNode(db, base.ws, 'offline', stale, 'poll');

    const kept = [
      await insertQueuedDelivery(db, base, pushNode),
      await insertQueuedDelivery(db, base, pollNode),
    ];

    const batch = await deadLetterUnreachableDeliveryBatch(db, base.ws, UNREACHABLE_NODE_GRACE_MS, now);
    expect(batch.expiredCount).toBe(0);
    for (const id of kept) {
      expect((await deliveryStatus(db, id)).status).toBe('queued');
    }
  });

  it('drains past a crowd of delivery-free stale nodes', async () => {
    const { db } = openDb();
    const base = await seed(db);
    const now = new Date();
    // Well over the old fixed node page (90): these would have hidden node_m.
    for (let i = 0; i < 100; i++) {
      await insertNode(db, base.ws, 'offline', new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 120_000));
    }
    const mailNode = await insertNode(db, base.ws, 'offline', new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 60_000));
    const deliveryId = await insertQueuedDelivery(db, base, mailNode);

    const batch = await deadLetterUnreachableDeliveryBatch(db, base.ws, UNREACHABLE_NODE_GRACE_MS, now);
    expect(batch.expiredCount).toBe(1);
    expect((await deliveryStatus(db, deliveryId)).status).toBe('dead_lettered');
  });

  // Production D1 regression: the global sweep drove from the FK index over
  // every delivery ever routed to a node (~250k rows read, 3.5-4.6s per run)
  // to find the few still active.
  it('reads only active deliveries, never the whole routed-delivery history', async () => {
    const handle = openDb();
    const base = await seed(handle.db);
    const now = new Date();
    const deadNode = await insertNode(handle.db, base.ws, 'offline', new Date(now.getTime() - UNREACHABLE_NODE_GRACE_MS - 60_000));
    const settled = await insertQueuedDelivery(handle.db, base, deadNode);
    await handle.db.update(deliveries).set({ status: 'acked' }).where(eq(deliveries.id, settled));
    const active = await insertQueuedDelivery(handle.db, base, deadNode);

    const statements: string[] = [];
    const prepare = handle.sqlite.prepare.bind(handle.sqlite);
    handle.sqlite.prepare = ((source: string) => {
      statements.push(source);
      return prepare(source);
    }) as typeof handle.sqlite.prepare;
    let batch: Awaited<ReturnType<typeof deadLetterUnreachableDeliveryBatch>>;
    try {
      batch = await deadLetterUnreachableDeliveryBatch(handle.db, undefined, UNREACHABLE_NODE_GRACE_MS, now);
    } finally {
      handle.sqlite.prepare = prepare;
    }
    expect(batch.notices.map((notice) => notice.delivery_id)).toEqual([active]);
    expect((await deliveryStatus(handle.db, settled)).status).toBe('acked');

    const candidateSql = statements.find((source) => source.startsWith('select') && source.includes('"nodes"."last_heartbeat_at" asc'));
    expect(candidateSql).toBeDefined();
    const params = (candidateSql!.match(/\?/g) ?? []).map(() => 0);
    const plan = (handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all(...params) as Array<{ detail: string }>)
      .map((step) => step.detail)
      .join('\n');
    expect(plan).toContain('idx_deliveries_active_location_node');
    expect(plan).not.toContain('idx_deliveries_location_node_fk');
  });
});
