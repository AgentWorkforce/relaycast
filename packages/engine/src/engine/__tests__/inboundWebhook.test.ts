import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { agents, channels, messageSessions, messages, webhooks, workspaces } from '../../db/schema.js';
import { createWebhook, triggerWebhook } from '../inboundWebhook.js';
import { publicMessageMetadata } from '../messageMetadata.js';

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

interface Seeded {
  ws: string;
  ch: string;
  agent: string;
}

type Db = SqliteDbHandle['db'];

async function seedWorkspace(db: Db): Promise<Seeded> {
  const n = ++seq;
  const ws = `ws_${n}`;
  await db.insert(workspaces).values({ id: ws, name: `w${n}`, apiKeyHash: `hash_${n}` });

  const ch = `ch_${n}`;
  await db.insert(channels).values({ id: ch, workspaceId: ws, name: 'general' });

  const agent = `ag_${n}`;
  await db.insert(agents).values({ id: agent, workspaceId: ws, name: 'alice', tokenHash: `tok_${n}` });

  return { ws, ch, agent };
}

async function readMessageMetadata(db: Db, messageId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.id, messageId));

  expect(row).toBeDefined();
  return row!.metadata ?? {};
}

describe('triggerWebhook payload round-trip', () => {
  it('persists relayfile metadata into the message row', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const webhook = await createWebhook(db, base.ws, base.ch, { name: 'relayfile:slack' }, base.agent);
    const relayfile = { provider: 'slack', path: '/slack/channels/C1', revision: 'r1' };

    const result = await triggerWebhook(db, webhook.webhook_id, webhook.token, {
      text: 'hello',
      source: 'relayfile',
      payload: { relayfile },
    });

    expect(result).not.toBeNull();
    const metadata = await readMessageMetadata(db, result!.message_id);
    expect(publicMessageMetadata(metadata).relayfile).toEqual(relayfile);
    expect(metadata.__relaycast_origin).toBe('inbound_webhook');
  });

  it('strips __relaycast_* keys that the caller tries to inject via payload', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const webhook = await createWebhook(db, base.ws, base.ch, { name: 'relayfile:slack' }, base.agent);
    const relayfile = { path: '/slack/x' };

    const result = await triggerWebhook(db, webhook.webhook_id, webhook.token, {
      text: 'hello',
      source: 'relayfile',
      payload: {
        __relaycast_origin: 'hacked',
        relayfile,
      },
    });

    expect(result).not.toBeNull();
    const metadata = await readMessageMetadata(db, result!.message_id);
    expect(publicMessageMetadata(metadata)).toEqual({ relayfile });
    expect(metadata.__relaycast_origin).toBe('inbound_webhook');
  });

  it('indexes session_ref from an authenticated webhook as replay evidence', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const webhook = await createWebhook(db, base.ws, base.ch, { name: 'protected' }, base.agent);

    const result = await triggerWebhook(db, webhook.webhook_id, webhook.token, {
      text: 'trusted replay marker',
      payload: { session_ref: 'protected-session' },
    });

    const [message] = await db
      .select({ sessionRef: messages.sessionRef })
      .from(messages)
      .where(eq(messages.id, result!.message_id));
    const ledger = await db
      .select({ sessionRef: messageSessions.sessionRef })
      .from(messageSessions)
      .where(eq(messageSessions.workspaceId, base.ws));
    expect(message).toBeDefined();
    expect(message!.sessionRef).toBe('protected-session');
    expect(ledger).toEqual([{ sessionRef: 'protected-session' }]);
  });

  it('preserves but does not index an unauthenticated webhook session_ref', async () => {
    const { db } = track(openDb());
    const base = await seedWorkspace(db);
    const webhook = await createWebhook(db, base.ws, base.ch, { name: 'legacy-open' }, base.agent);
    await db
      .update(webhooks)
      .set({ tokenHash: null })
      .where(eq(webhooks.id, webhook.webhook_id));

    const result = await triggerWebhook(db, webhook.webhook_id, null, {
      text: 'untrusted replay marker',
      payload: { session_ref: 'untrusted-session' },
    });

    const [message] = await db
      .select({ metadata: messages.metadata, sessionRef: messages.sessionRef })
      .from(messages)
      .where(eq(messages.id, result!.message_id));
    const ledger = await db
      .select({ sessionRef: messageSessions.sessionRef })
      .from(messageSessions)
      .where(eq(messageSessions.workspaceId, base.ws));
    expect(message).toBeDefined();
    expect(publicMessageMetadata(message!.metadata)).toEqual({ session_ref: 'untrusted-session' });
    expect(message!.sessionRef).toBeNull();
    expect(ledger).toEqual([]);
  });
});
