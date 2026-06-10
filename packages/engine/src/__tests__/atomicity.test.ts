import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  type TestStack,
} from './conformance/harness.js';
import { channels, deliveries, files, messageAttachments, messageLogs, messages, readReceipts, channelMembers } from '../db/schema.js';
import { postMessage } from '../engine/message.js';
import { sendDm } from '../engine/dm.js';
import { createGroupDm, postGroupMessage } from '../engine/groupDm.js';
import { postReply } from '../engine/thread.js';
import { markRead } from '../engine/receipt.js';
import type { EngineDb, TransactionCapability } from '../ports/database.js';

/**
 * Atomicity of multi-statement write paths.
 *
 * The Node adapter attaches `withTransaction` to its handle, so a failure
 * mid-send rolls back every row of the send. Adapters without the capability
 * (D1) fall back to plain sequential statements — same behavior as before.
 */
describe('transactional write paths (Node adapter)', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  /** Workspace + channel with alice and bob joined; no messages yet. */
  async function seed() {
    const ws = await createWorkspace(stack.app, 'txn-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const createRes = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createRes.status).toBeLessThan(300);
    for (const token of [alice.token, bob.token]) {
      const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(joinRes.status).toBeLessThan(300);
    }

    const db = stack.runtime.handle.db as unknown as EngineDb;
    const [channel] = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.name, 'team-chat'));

    return { ws, alice, bob, channelId: channel.id, db };
  }

  /** Make the next insert into `table` throw; returns a restore function. */
  function injectInsertFailure(db: EngineDb, table: unknown, message: string): () => void {
    const handle = db as unknown as { insert: (t: unknown) => unknown };
    const real = handle.insert.bind(db);
    handle.insert = (t: unknown) => {
      if (t === table) throw new Error(message);
      return real(t);
    };
    return () => { handle.insert = real; };
  }

  /** Make the next update of `table` throw; returns a restore function. */
  function injectUpdateFailure(db: EngineDb, table: unknown, message: string): () => void {
    const handle = db as unknown as { update: (t: unknown) => unknown };
    const real = handle.update.bind(db);
    handle.update = (t: unknown) => {
      if (t === table) throw new Error(message);
      return real(t);
    };
    return () => { handle.update = real; };
  }

  function stripCapability(db: EngineDb): void {
    delete (db as Partial<TransactionCapability>).withTransaction;
  }

  it('rolls back the message when the deliveries insert fails mid channel send', async () => {
    const { ws, alice, channelId, db } = await seed();

    const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
    await expect(
      postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' }),
    ).rejects.toThrow('injected deliveries failure');
    restore();

    // No orphan rows: the message and its log were rolled back with the deliveries.
    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(messageLogs)).toHaveLength(0);
    expect(await db.select().from(deliveries)).toHaveLength(0);
  });

  it('rolls back the message when the deliveries insert fails mid DM send', async () => {
    const { ws, alice, db } = await seed();

    const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
    await expect(
      sendDm(db, ws.workspaceId, alice.agentId, { to: 'bob', text: 'psst' }),
    ).rejects.toThrow('injected deliveries failure');
    restore();

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(messageLogs)).toHaveLength(0);
    expect(await db.select().from(deliveries)).toHaveLength(0);
  });

  it('rolls back group DM message and attachments when the deliveries insert fails', async () => {
    const { ws, alice, db } = await seed();
    const group = await createGroupDm(db, ws.workspaceId, alice.agentId, {
      participants: ['bob'],
      name: 'ops',
    });
    const fileId = 'file_group_attachment';
    await db.insert(files).values({
      id: fileId,
      workspaceId: ws.workspaceId,
      uploadedBy: alice.agentId,
      filename: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
      storageKey: `${ws.workspaceId}/${fileId}/notes.txt`,
      status: 'complete',
    });

    const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
    await expect(
      postGroupMessage(db, ws.workspaceId, group.id, alice.agentId, {
        text: 'hello group',
        attachments: [fileId],
      }),
    ).rejects.toThrow('injected deliveries failure');
    restore();

    expect(await db.select().from(messages)).toHaveLength(0);
    expect(await db.select().from(messageAttachments)).toHaveLength(0);
    expect(await db.select().from(deliveries)).toHaveLength(0);
    expect(await db.select().from(files)).toHaveLength(1);
  });

  it('rolls back thread replies when the deliveries insert fails', async () => {
    const { ws, alice, bob, channelId, db } = await seed();
    const parent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });

    const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
    await expect(
      postReply(db, ws.workspaceId, parent.id, bob.agentId, { text: 'reply' }),
    ).rejects.toThrow('injected deliveries failure');
    restore();

    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(messages).where(eq(messages.threadId, parent.id))).toHaveLength(0);
    expect(await db.select().from(messageLogs)).toHaveLength(1);
    expect(await db.select().from(deliveries)).toHaveLength(1);
  });

  it('rolls back markRead read state when the lastReadId update fails', async () => {
    const { ws, alice, bob, channelId, db } = await seed();
    const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });

    const restore = injectUpdateFailure(db, channelMembers, 'injected lastReadId failure');
    await expect(markRead(db, ws.workspaceId, sent.id, bob.agentId)).rejects.toThrow(
      'injected lastReadId failure',
    );
    restore();

    // The receipt insert and delivery transition were rolled back with it.
    expect(await db.select().from(readReceipts)).toHaveLength(0);
    const [delivery] = await db.select().from(deliveries);
    expect(delivery.status).toBe('accepted');

    // And the path still completes once nothing fails.
    const receipt = await markRead(db, ws.workspaceId, sent.id, bob.agentId);
    expect(receipt?.message_id).toBe(sent.id);
    expect(await db.select().from(readReceipts)).toHaveLength(1);
  });

  it('commits concurrent transactional sends without interleaving', async () => {
    const { ws, alice, channelId, db } = await seed();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: `msg ${i}` }),
      ),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(5);
    expect(await db.select().from(messages)).toHaveLength(5);
    // One delivery per message for bob, the only other member.
    expect(await db.select().from(deliveries)).toHaveLength(5);
  });

  describe('without the transaction capability (sequential fallback)', () => {
    it('still sends successfully', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      stripCapability(db);

      const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });
      expect(sent.id).toBeTruthy();
      expect(await db.select().from(messages)).toHaveLength(1);
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.agentId).toBe(bob.agentId);
      expect(await db.select().from(messageLogs)).toHaveLength(1);
    });

    it('leaves the orphan message on mid-send failure (pre-capability behavior)', async () => {
      const { ws, alice, channelId, db } = await seed();
      stripCapability(db);

      const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
      await expect(
        postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' }),
      ).rejects.toThrow('injected deliveries failure');
      restore();

      // Sequential statements have no rollback: the message row survives
      // with no delivery rows — exactly the documented D1 behavior.
      expect(await db.select().from(messages)).toHaveLength(1);
      expect(await db.select().from(deliveries)).toHaveLength(0);
    });
  });
});
