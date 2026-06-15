import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import {
  agents,
  channels,
  deliveries,
  files,
  messageAttachments,
  messageLogs,
  messages,
  reactions,
  readReceipts,
  workspaces,
  type WorkspaceRetentionSettings,
} from '../../db/schema.js';
import { pruneExpired } from '../retention.js';
import { snowflakeIdLowerBound } from '../snowflake.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let seq = 0;

function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  return handle;
}

const handles: SqliteDbHandle[] = [];
function track(handle: SqliteDbHandle): SqliteDbHandle {
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

/** A snowflake ID minted `daysAgo` days in the past (plus a small offset for uniqueness). */
function idAt(daysAgo: number, offset = 0): string {
  return (BigInt(snowflakeIdLowerBound(Date.now() - daysAgo * DAY_MS)) + BigInt(offset)).toString();
}

interface Seeded {
  ws: string;
  ch: string;
  agent: string;
}

type Db = SqliteDbHandle['db'];

async function seedWorkspace(db: Db, retention?: WorkspaceRetentionSettings | null): Promise<Seeded> {
  const n = ++seq;
  const ws = `ws_${n}`;
  await db.insert(workspaces).values({ id: ws, name: `w${n}`, apiKeyHash: `hash_${n}`, retention });
  const ch = `ch_${n}`;
  await db.insert(channels).values({ id: ch, workspaceId: ws, name: 'general' });
  const agent = `ag_${n}`;
  await db.insert(agents).values({ id: agent, workspaceId: ws, name: 'alice', tokenHash: `tok_${n}` });
  return { ws, ch, agent };
}

async function insertMessage(db: Db, base: Seeded, id: string, threadId?: string): Promise<string> {
  await db.insert(messages).values({
    id,
    workspaceId: base.ws,
    channelId: base.ch,
    agentId: base.agent,
    threadId: threadId ?? null,
    body: `body ${id}`,
  });
  return id;
}

// Distinct per-agent seq: the fleet mailbox migration added a
// UNIQUE(workspace_id, agent_id, seq) index, so multiple deliveries for one
// agent can no longer share the default seq of 0.
let deliverySeqCounter = 0;

async function insertDelivery(
  db: Db,
  base: Seeded,
  messageId: string,
  status: string,
  daysAgo: number,
): Promise<string> {
  const id = `del_${messageId}_${base.agent}`;
  await db.insert(deliveries).values({
    id,
    workspaceId: base.ws,
    messageId,
    agentId: base.agent,
    status,
    seq: ++deliverySeqCounter,
    createdAt: new Date(Date.now() - daysAgo * DAY_MS),
  });
  return id;
}

async function insertMessageLog(db: Db, base: Seeded, messageId: string, id: string): Promise<string> {
  await db.insert(messageLogs).values({
    id,
    workspaceId: base.ws,
    messageId,
    channelId: base.ch,
    agentId: base.agent,
    deliveryKind: 'channel',
    body: `body ${messageId}`,
  });
  return id;
}

describe('pruneExpired', () => {
  it('deletes nothing when retention is off everywhere', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const oldMsg = await insertMessage(db, base, idAt(400));
    await insertDelivery(db, base, oldMsg, 'acked', 400);
    await insertMessageLog(db, base, oldMsg, idAt(400, 1));

    const result = await pruneExpired(db, {
      defaults: { messageTtlDays: null, deliveryTtlDays: null, messageLogTtlDays: null },
    });

    expect(result).toEqual({ messages: 0, deliveries: 0, messageLogs: 0, readReceipts: 0 });
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(deliveries)).toHaveLength(1);
    expect(await db.select().from(messageLogs)).toHaveLength(1);
  });

  it('never prunes messages by default — operational tables only', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const oldMsg = await insertMessage(db, base, idAt(400));
    await insertDelivery(db, base, oldMsg, 'acked', 400);
    await insertMessageLog(db, base, oldMsg, idAt(400, 1));

    const result = await pruneExpired(db);

    expect(result.messages).toBe(0);
    expect(result.deliveries).toBe(1);
    expect(result.messageLogs).toBe(1);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(deliveries)).toHaveLength(0);
    expect(await db.select().from(messageLogs)).toHaveLength(0);
  });

  it('prunes messages past the workspace TTL and leaves other workspaces alone', async () => {
    const { db } = track(openDb());
    const optedIn = await seedWorkspace(db, { message_ttl_days: 30 });
    const untouched = await seedWorkspace(db);

    const expired = await insertMessage(db, optedIn, idAt(40));
    const fresh = await insertMessage(db, optedIn, idAt(10));
    const otherOld = await insertMessage(db, untouched, idAt(40, 1));

    const result = await pruneExpired(db);

    expect(result.messages).toBe(1);
    const remaining = (await db.select({ id: messages.id }).from(messages)).map((r) => r.id);
    expect(remaining.sort()).toEqual([fresh, otherOld].sort());
    expect(remaining).not.toContain(expired);
  });

  it('cascades message deletion to receipts, reactions, attachments, logs, and deliveries', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db, { message_ttl_days: 30 });
    const expired = await insertMessage(db, base, idAt(40));

    await db.insert(readReceipts).values({ messageId: expired, agentId: base.agent });
    await db.insert(reactions).values({ id: idAt(40, 1), messageId: expired, agentId: base.agent, emoji: 'tada' });
    await db.insert(files).values({
      id: `file_${base.ws}`,
      workspaceId: base.ws,
      uploadedBy: base.agent,
      filename: 'a.txt',
      contentType: 'text/plain',
      sizeBytes: 1,
      storageKey: `k_${base.ws}`,
    });
    await db.insert(messageAttachments).values({ messageId: expired, fileId: `file_${base.ws}` });
    await insertMessageLog(db, base, expired, idAt(40, 2));
    await insertDelivery(db, base, expired, 'delivered', 40);

    const result = await pruneExpired(db);

    expect(result.messages).toBe(1);
    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(readReceipts)).toHaveLength(0);
    expect(await db.select().from(reactions)).toHaveLength(0);
    expect(await db.select().from(messageAttachments)).toHaveLength(0);
    expect(await db.select().from(messageLogs)).toHaveLength(0);
    expect(await db.select().from(deliveries)).toHaveLength(0);
  });

  it('keeps a thread parent while a fresh reply references it', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db, { message_ttl_days: 30 });
    const parent = await insertMessage(db, base, idAt(40));
    await insertMessage(db, base, idAt(10), parent);

    const result = await pruneExpired(db);

    expect(result.messages).toBe(0);
    expect(await db.select().from(messages)).toHaveLength(2);
  });

  it('prunes expired threads leaf-first across successive runs', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db, { message_ttl_days: 30 });
    const parent = await insertMessage(db, base, idAt(50));
    await insertMessage(db, base, idAt(45), parent);

    const first = await pruneExpired(db);
    expect(first.messages).toBe(1); // reply only; parent still referenced when selected

    const second = await pruneExpired(db);
    expect(second.messages).toBe(1); // parent, now a leaf
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('honors batchLimit and maxBatches', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db, { message_ttl_days: 30 });
    for (let i = 0; i < 5; i++) await insertMessage(db, base, idAt(40, i));

    const capped = await pruneExpired(db, { batchLimit: 2, maxBatches: 1 });
    expect(capped.messages).toBe(2);
    expect(await db.select().from(messages)).toHaveLength(3);

    const rest = await pruneExpired(db, { batchLimit: 2, maxBatches: 5 });
    expect(rest.messages).toBe(3);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it('prunes only settled deliveries past the TTL', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const m1 = await insertMessage(db, base, idAt(100));
    const m2 = await insertMessage(db, base, idAt(100, 1));
    const m3 = await insertMessage(db, base, idAt(100, 2));
    const m4 = await insertMessage(db, base, idAt(100, 3));

    await insertDelivery(db, base, m1, 'acked', 100); // settled + old -> pruned
    await insertDelivery(db, base, m2, 'failed', 100); // settled + old -> pruned
    await insertDelivery(db, base, m3, 'queued', 100); // in-flight -> kept
    await insertDelivery(db, base, m4, 'acked', 10); // settled + fresh -> kept

    const result = await pruneExpired(db);

    expect(result.deliveries).toBe(2);
    const remaining = (await db.select({ status: deliveries.status }).from(deliveries)).map((r) => r.status);
    expect(remaining.sort()).toEqual(['acked', 'queued']);
  });

  it('lets a workspace override or disable the operational defaults', async () => {
    const { db } = track(openDb());
    const disabled = await seedWorkspace(db, { delivery_ttl_days: null, message_log_ttl_days: null });
    const aggressive = await seedWorkspace(db, { delivery_ttl_days: 7, message_log_ttl_days: 7 });

    const mA = await insertMessage(db, disabled, idAt(100));
    await insertDelivery(db, disabled, mA, 'acked', 100);
    await insertMessageLog(db, disabled, mA, idAt(100, 1));

    const mB = await insertMessage(db, aggressive, idAt(10, 2));
    await insertDelivery(db, aggressive, mB, 'acked', 10);
    await insertMessageLog(db, aggressive, mB, idAt(10, 3));

    const result = await pruneExpired(db);

    // The disabled workspace keeps 100-day-old rows; the aggressive one loses 10-day-old rows.
    expect(result.deliveries).toBe(1);
    expect(result.messageLogs).toBe(1);
    expect((await db.select().from(deliveries)).map((r) => r.workspaceId)).toEqual([disabled.ws]);
    expect((await db.select().from(messageLogs)).map((r) => r.workspaceId)).toEqual([disabled.ws]);
  });

  it('sweeps read receipts orphaned by deleted messages', async () => {
    const { db, sqlite } = track(openDb());
    const base = await seedWorkspace(db);
    const live = await insertMessage(db, base, idAt(1));
    await db.insert(readReceipts).values({ messageId: live, agentId: base.agent });

    // Simulate rows written while FK enforcement was off.
    sqlite.pragma('foreign_keys = OFF');
    await db.insert(readReceipts).values({ messageId: 'msg_gone', agentId: base.agent });
    sqlite.pragma('foreign_keys = ON');

    const result = await pruneExpired(db);

    expect(result.readReceipts).toBe(1);
    const remaining = await db.select().from(readReceipts).where(eq(readReceipts.agentId, base.agent));
    expect(remaining.map((r) => r.messageId)).toEqual([live]);
  });
});
