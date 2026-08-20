import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  type TestStack,
} from './conformance/harness.js';
import {
  agentIdentityAudit,
  agents,
  channelMembers,
  channels,
  deliveries,
  files,
  messageAttachments,
  messageLogs,
  messages,
  readReceipts,
} from '../db/schema.js';
import { postMessage } from '../engine/message.js';
import { sendDm } from '../engine/dm.js';
import { createGroupDm, postGroupMessage } from '../engine/groupDm.js';
import { postReply } from '../engine/thread.js';
import { markRead } from '../engine/receipt.js';
import { rotateAgentIdentity } from '../engine/agentIdentity.js';
import type { AtomicWrite, EngineDb, TransactionCapability } from '../ports/database.js';

/**
 * Atomicity of multi-statement write paths.
 *
 * Three handle shapes, in `runAtomicWrites` priority order:
 *  1. Transaction-capable (Node adapter attaches `withTransaction`) — a
 *     failure mid-send rolls back every row of the send.
 *  2. Batch-capable (D1-style: the handle exposes `batch()`, as drizzle's
 *     `DrizzleD1Database` does natively) — all writes run as one atomic batch.
 *  3. Neither — plain sequential statements, the engine's historical behavior.
 */
describe('atomic write paths', () => {
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

  /**
   * Wrap a built statement so it fails when *executed* (awaited), not when
   * built. Write paths build their statement list up front, so a build-time
   * throw would abort before any write executes and never exercise rollback;
   * an execution-time failure lands mid-transaction / mid-batch / mid-sequence
   * — the crash the atomicity machinery exists for. Builder chaining and
   * `toSQL()` still delegate to the real statement.
   */
  function failOnExecute<T extends object>(target: T, message: string): T {
    return new Proxy(target, {
      get(obj, prop) {
        if (prop === 'then') {
          return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.reject(new Error(message)).then(onFulfilled, onRejected);
        }
        const value = Reflect.get(obj, prop) as unknown;
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown).apply(obj, args);
            return result && typeof result === 'object' ? failOnExecute(result as object, message) : result;
          };
        }
        return value;
      },
    });
  }

  /** Make statements inserting into `table` fail at execution; returns a restore function. */
  function injectInsertFailure(db: EngineDb, table: unknown, message: string): () => void {
    const handle = db as unknown as { insert: (t: unknown) => object };
    const real = handle.insert.bind(db);
    handle.insert = (t: unknown) => {
      const builder = real(t);
      return t === table ? failOnExecute(builder, message) : builder;
    };
    return () => { handle.insert = real; };
  }

  /** Make statements updating `table` fail at execution; returns a restore function. */
  function injectUpdateFailure(db: EngineDb, table: unknown, message: string): () => void {
    const handle = db as unknown as { update: (t: unknown) => object };
    const real = handle.update.bind(db);
    handle.update = (t: unknown) => {
      const builder = real(t);
      return t === table ? failOnExecute(builder, message) : builder;
    };
    return () => { handle.update = real; };
  }

  function stripCapability(db: EngineDb): void {
    delete (db as Partial<TransactionCapability>).withTransaction;
  }

  /**
   * Turn the Node handle into a D1-shaped one: no `withTransaction`, but a
   * `batch()` that executes every statement inside one underlying SQLite
   * transaction (all-or-nothing, like D1) and records each batch's SQL.
   */
  function attachFakeBatch(db: EngineDb, beforeExecute?: () => Promise<void>): string[][] {
    stripCapability(db);
    const sqlite = stack.runtime.handle.sqlite;
    const batches: string[][] = [];
    (db as unknown as Record<string, unknown>).batch = async (
      statements: ReadonlyArray<AtomicWrite & { toSQL(): { sql: string } }>,
    ): Promise<unknown[]> => {
      batches.push(statements.map((s) => s.toSQL().sql));
      await beforeExecute?.();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: unknown[] = [];
        for (const statement of statements) {
          results.push(await statement);
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw err;
      }
    };
    return batches;
  }

  function expectStatementOn(batch: string[], verb: 'insert' | 'update', table: string): void {
    const pattern = verb === 'insert' ? `insert into "${table}"` : `update "${table}"`;
    expect(
      batch.some((sql) => sql.startsWith(pattern)),
      `expected a \`${pattern}\` statement in batch: ${JSON.stringify(batch)}`,
    ).toBe(true);
  }

  describe('with the transaction capability (Node adapter)', () => {
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
      expect(delivery.status).toBe('queued');

      // And the path still completes once nothing fails.
      const receipt = await markRead(db, ws.workspaceId, sent.id, bob.agentId);
      expect(receipt?.message_id).toBe(sent.id);
      expect(await db.select().from(readReceipts)).toHaveLength(1);
    });

    it('commits concurrent transactional sends without interleaving', async () => {
      const { ws, alice, bob, channelId, db } = await seed();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: `msg ${i}` }),
        ),
      );

      expect(new Set(results.map((r) => r.id)).size).toBe(5);
      expect(await db.select().from(messages)).toHaveLength(5);
      // One delivery per message for bob, the only other member. Concurrent
      // inserts allocate distinct values and advance the durable high-water.
      const deliveryRows = await db
        .select({ seq: deliveries.seq })
        .from(deliveries)
        .where(eq(deliveries.agentId, bob.agentId));
      expect(deliveryRows.map((row) => row.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
      const [recipient] = await db
        .select({ deliverySeq: agents.deliverySeq })
        .from(agents)
        .where(eq(agents.id, bob.agentId));
      expect(recipient.deliverySeq).toBe(5);
    });
  });

  describe('with a batch-capable handle (D1-style)', () => {
    it('atomically rotates an identity and appends its audit record', async () => {
      const { ws, alice, db } = await seed();
      const [before] = await db
        .select({ tokenHash: agents.tokenHash })
        .from(agents)
        .where(eq(agents.id, alice.agentId));
      const batches = attachFakeBatch(db);

      const recovered = await rotateAgentIdentity(db, {
        workspaceId: ws.workspaceId,
        agentId: alice.agentId,
        agentName: 'alice',
      }, {
        authority: 'current_agent_token',
        actor: 'agent:alice',
        reason: 'D1 atomicity test',
        originActor: 'conformance/atomicity',
      });

      expect(recovered.audit_id).toMatch(/^aid_/);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expectStatementOn(batches[0], 'update', 'agents');
      expectStatementOn(batches[0], 'insert', 'agent_identity_audit');
      const [after] = await db
        .select({ tokenHash: agents.tokenHash, previousTokenHash: agents.previousTokenHash })
        .from(agents)
        .where(eq(agents.id, alice.agentId));
      expect(after.tokenHash).not.toBe(before.tokenHash);
      expect(after.previousTokenHash).toBe(before.tokenHash);
      expect(await db.select().from(agentIdentityAudit)).toHaveLength(1);
    });

    it('does not append an audit record when the target changes before a D1 batch', async () => {
      const { ws, alice, db } = await seed();
      attachFakeBatch(db, async () => {
        await db
          .update(agents)
          .set({ name: 'alice-renamed' })
          .where(eq(agents.id, alice.agentId));
      });

      await expect(rotateAgentIdentity(db, {
        workspaceId: ws.workspaceId,
        agentId: alice.agentId,
        agentName: 'alice',
      }, {
        authority: 'current_agent_token',
        actor: 'agent:alice',
        reason: 'stale target test',
        originActor: 'conformance/atomicity',
      })).rejects.toMatchObject({ code: 'agent_identity_conflict' });

      expect(await db.select().from(agentIdentityAudit)).toHaveLength(0);
    });

    it('channel send issues exactly one batch: message + deliveries + message_log', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      const batches = attachFakeBatch(db);

      const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expectStatementOn(batches[0], 'insert', 'messages');
      expectStatementOn(batches[0], 'insert', 'deliveries');
      expectStatementOn(batches[0], 'insert', 'message_logs');

      // `.returning()` rows come back through the batch results.
      expect(sent.id).toBeTruthy();
      expect(sent.text).toBe('hello');
      expect(Date.parse(sent.created_at)).not.toBeNaN();

      expect(await db.select().from(messages)).toHaveLength(1);
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.agentId).toBe(bob.agentId);
      expect(await db.select().from(messageLogs)).toHaveLength(1);
    });

    it('channel deliveries are derived from membership at batch execution time', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      let removed = false;
      attachFakeBatch(db, async () => {
        if (removed) return;
        removed = true;
        await db
          .delete(channelMembers)
          .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, bob.agentId)));
      });

      const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });

      expect(sent._deliveries).toHaveLength(0);
      expect(await db.select().from(messages)).toHaveLength(1);
      expect(await db.select().from(deliveries)).toHaveLength(0);
    });

    it('DM send issues exactly one batch: message + delivery + message_log', async () => {
      const { ws, alice, bob, db } = await seed();
      const batches = attachFakeBatch(db);

      const sent = await sendDm(db, ws.workspaceId, alice.agentId, { to: 'bob', text: 'psst' });

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expectStatementOn(batches[0], 'insert', 'messages');
      expectStatementOn(batches[0], 'insert', 'deliveries');
      expectStatementOn(batches[0], 'insert', 'message_logs');

      expect(sent.message.id).toBeTruthy();
      const dmMessages = await db.select().from(messages);
      expect(dmMessages).toHaveLength(1);
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.agentId).toBe(bob.agentId);
      expect(await db.select().from(messageLogs)).toHaveLength(1);
    });

    it('group DM send issues exactly one batch: message + deliveries', async () => {
      const { ws, alice, bob, db } = await seed();
      const conv = await createGroupDm(db, ws.workspaceId, alice.agentId, { participants: ['bob'] });
      const batches = attachFakeBatch(db);

      const sent = await postGroupMessage(db, ws.workspaceId, conv.id, alice.agentId, { text: 'hi group' });

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expectStatementOn(batches[0], 'insert', 'messages');
      expectStatementOn(batches[0], 'insert', 'deliveries');

      expect(sent.message.id).toBeTruthy();
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.agentId).toBe(bob.agentId);
      expect(delivery.messageId).toBe(sent.message.id);
    });

    it('thread reply issues exactly one batch: reply + deliveries', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      const parent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'root' });
      const batches = attachFakeBatch(db);

      const reply = await postReply(db, ws.workspaceId, parent.id, bob.agentId, { text: 'on it' });

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(2);
      expectStatementOn(batches[0], 'insert', 'messages');
      expectStatementOn(batches[0], 'insert', 'deliveries');

      expect(reply.thread_id).toBe(parent.id);
      const [delivery] = await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.messageId, reply.id));
      expect(delivery.agentId).toBe(alice.agentId);
    });

    it('markRead issues exactly one batch: receipt + delivery transition + lastReadId', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });
      const batches = attachFakeBatch(db);

      const receipt = await markRead(db, ws.workspaceId, sent.id, bob.agentId);

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
      expectStatementOn(batches[0], 'insert', 'read_receipts');
      expectStatementOn(batches[0], 'update', 'deliveries');
      expectStatementOn(batches[0], 'update', 'channel_members');

      expect(receipt?.message_id).toBe(sent.id);
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.status).toBe('acked');
    });

    it('a failed batch applies nothing — no orphan message rows', async () => {
      const { ws, alice, channelId, db } = await seed();
      const batches = attachFakeBatch(db);

      const restore = injectInsertFailure(db, deliveries, 'injected deliveries failure');
      await expect(
        postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' }),
      ).rejects.toThrow('injected deliveries failure');
      restore();

      // The batch was attempted (failure happened inside it, not before it)...
      expect(batches).toHaveLength(1);
      // ...and all-or-nothing semantics rolled back everything, message included.
      expect(await db.select().from(messages)).toHaveLength(0);
      expect(await db.select().from(deliveries)).toHaveLength(0);
      expect(await db.select().from(messageLogs)).toHaveLength(0);
    });
  });

  describe('with neither capability (sequential fallback)', () => {
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

    it('still marks read successfully', async () => {
      const { ws, alice, bob, channelId, db } = await seed();
      const sent = await postMessage(db, ws.workspaceId, channelId, alice.agentId, { text: 'hello' });
      stripCapability(db);

      const receipt = await markRead(db, ws.workspaceId, sent.id, bob.agentId);
      expect(receipt?.message_id).toBe(sent.id);
      const [delivery] = await db.select().from(deliveries);
      expect(delivery.status).toBe('acked');
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
      // with no delivery rows — exactly the historical bare-handle behavior.
      expect(await db.select().from(messages)).toHaveLength(1);
      expect(await db.select().from(deliveries)).toHaveLength(0);
    });
  });
});
