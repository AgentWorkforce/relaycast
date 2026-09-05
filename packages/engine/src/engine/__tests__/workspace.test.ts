import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import { channels, workspaceCreateIdempotency, workspaces } from '../../db/schema.js';
import { hmacSha256Hex, sha256Hex } from '../../lib/crypto.js';
import type {
  AtomicWrite,
  BatchCapability,
  EngineDb,
  TransactionCapability,
} from '../../ports/database.js';
import * as snowflake from '../snowflake.js';
import { createWorkspace, deleteWorkspace, workspaceCreateRequestDigest } from '../workspace.js';

describe('workspace write durability', () => {
  let stack: TestStack;
  let db: EngineDb;

  beforeEach(() => {
    stack = makeNodeStack();
    db = stack.runtime.handle.db as unknown as EngineDb;
    delete (db as Partial<TransactionCapability>).withTransaction;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    stack?.close();
  });

  function attachD1Batch(options: {
    failAfterFirstStatement?: boolean;
    failAfterLostResponse?: boolean;
    failBeforeFirst?: boolean;
    loseFirstResponse?: boolean;
    beforeFirstBatch?: () => void | Promise<void>;
  }): () => number {
    let calls = 0;
    const sqlite = stack.runtime.handle.sqlite;

    (db as EngineDb & Partial<BatchCapability>).batch = async (statements) => {
      calls += 1;
      if (calls === 1 && options.failBeforeFirst) {
        throw new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.');
      }
      if (calls > 1 && options.failAfterLostResponse) {
        throw new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.');
      }
      if (calls === 1 && options.beforeFirstBatch) {
        await options.beforeFirstBatch();
      }

      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: unknown[] = [];
        for (const statement of statements as ReadonlyArray<AtomicWrite>) {
          results.push(await statement);
          if (calls === 1 && options.failAfterFirstStatement && results.length === 1) {
            throw new Error('D1_TYPE_ERROR: injected channel insert failure');
          }
        }
        sqlite.exec('COMMIT');
        if (calls === 1 && options.loseFirstResponse) {
          throw new Error('D1_ERROR: Network connection lost.');
        }
        return results;
      } catch (error) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw error;
      }
    };

    return () => calls;
  }

  async function expectOneCompleteWorkspace(workspaceId: string): Promise<void> {
    const workspaceRows = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const channelRows = await db
      .select()
      .from(channels)
      .where(eq(channels.workspaceId, workspaceId));

    expect(workspaceRows).toHaveLength(1);
    expect(channelRows).toHaveLength(1);
    expect(channelRows[0]?.name).toBe('general');
  }

  function useGeneratedPair(): { workspaceId: string; channelId: string } {
    const pair = {
      workspaceId: 'generated-workspace-id',
      channelId: 'generated-channel-id',
    };
    vi.spyOn(snowflake, 'generateId')
      .mockReturnValueOnce(pair.workspaceId)
      .mockReturnValueOnce(pair.channelId);
    return pair;
  }

  async function seedDeletionWorkspace(id: string): Promise<void> {
    await db.insert(workspaces).values({
      id,
      name: id,
      apiKeyHash: `${id}-hash`,
    });
  }

  it('retries a transient D1 failure and commits workspace plus channel atomically', async () => {
    const batchCalls = attachD1Batch({ failBeforeFirst: true });

    const created = await createWorkspace(db, 'transient-retry');

    expect(batchCalls()).toBe(2);
    await expectOneCompleteWorkspace(created.workspace_id);
  });

  it('rolls back the workspace when the channel insert fails mid-batch', async () => {
    attachD1Batch({ failAfterFirstStatement: true });

    await expect(createWorkspace(db, 'mid-batch-failure')).rejects.toThrow(
      'injected channel insert failure',
    );

    expect(await db.select().from(workspaces)).toHaveLength(0);
    expect(await db.select().from(channels)).toHaveLength(0);
  });

  it('rejects a bare database handle instead of degrading to sequential writes', async () => {
    delete (db as Partial<BatchCapability>).batch;

    await expect(createWorkspace(db, 'non-atomic-handle')).rejects.toThrow(
      'Atomic write capability required',
    );

    expect(await db.select().from(workspaces)).toHaveLength(0);
    expect(await db.select().from(channels)).toHaveLength(0);
  });

  it('rolls back the channel when the generated workspace id collides', async () => {
    attachD1Batch({});
    const { workspaceId, channelId } = useGeneratedPair();
    await db.insert(workspaces).values({
      id: workspaceId,
      name: 'unrelated-workspace',
      apiKeyHash: 'unrelated-workspace-hash',
    });

    await expect(createWorkspace(db, 'workspace-id-collision')).rejects.toMatchObject({
      code: 'workspace_id_collision',
    });

    await expect(db.select().from(workspaces).where(eq(workspaces.id, workspaceId))).resolves.toMatchObject([
      { name: 'unrelated-workspace', apiKeyHash: 'unrelated-workspace-hash' },
    ]);
    expect(await db.select().from(channels).where(eq(channels.id, channelId))).toHaveLength(0);
  });

  it('rolls back the workspace when the generated channel id collides', async () => {
    attachD1Batch({});
    const { workspaceId, channelId } = useGeneratedPair();
    const existingWorkspaceId = 'existing-channel-owner';
    await db.insert(workspaces).values({
      id: existingWorkspaceId,
      name: 'channel-owner',
      apiKeyHash: 'channel-owner-hash',
    });
    await db.insert(channels).values({
      id: channelId,
      workspaceId: existingWorkspaceId,
      name: 'unrelated-channel',
      topic: 'Existing channel',
    });

    await expect(createWorkspace(db, 'channel-id-collision')).rejects.toMatchObject({
      code: 'workspace_id_collision',
    });

    expect(await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))).toHaveLength(0);
    await expect(db.select().from(channels).where(eq(channels.id, channelId))).resolves.toMatchObject([
      { workspaceId: existingWorkspaceId, name: 'unrelated-channel' },
    ]);
  });

  it('replays idempotently when D1 commits but its response is lost', async () => {
    const batchCalls = attachD1Batch({ loseFirstResponse: true });

    const created = await createWorkspace(db, 'lost-response');

    expect(batchCalls()).toBe(2);
    await expectOneCompleteWorkspace(created.workspace_id);
  });

  it('recovers a delegated child key after commit/response loss', async () => {
    const batchCalls = attachD1Batch({ loseFirstResponse: true });
    const ownerApiKey = 'rk_live_parent_for_recovery';
    const requestDigest = await workspaceCreateRequestDigest({ name: 'delegated-child', expiresInSeconds: 3_600 });
    const created = await createWorkspace(db, 'delegated-child', {
      ownerApiKey, idempotencyKey: 'cloud-job-123', requestDigest,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(batchCalls()).toBe(2);
    // The first write committed before its response was lost, so this is a
    // recovery of this invocation's own create and must retain 201 semantics.
    expect(created.created).toBe(true);
    expect(created.api_key).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(await db.select().from(workspaces)).toHaveLength(1);
    expect(await db.select().from(workspaceCreateIdempotency)).toHaveLength(1);

    const replay = await createWorkspace(db, 'delegated-child', {
      ownerApiKey, idempotencyKey: 'cloud-job-123', requestDigest,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(replay.created).toBe(false);
    expect(replay.workspace_id).toBe(created.workspace_id);
    expect(replay.api_key).toBe(created.api_key);
  });

  it('does not treat an unrelated workspace-id collision as own recovery', async () => {
    const ownerApiKey = 'rk_live_collision_owner';
    const idempotencyKey = 'collision-job';
    const requestDigest = await workspaceCreateRequestDigest({ name: 'collision-child' });
    const deterministicApiKey = `rk_live_${(await hmacSha256Hex(
      `relaycast:workspace-create:v1:${idempotencyKey}:${requestDigest}`,
      ownerApiKey,
    )).slice(0, 32)}`;
    const pair = useGeneratedPair();

    attachD1Batch({
      beforeFirstBatch: async () => {
        await db.insert(workspaces).values({
          id: pair.workspaceId,
          name: 'collision-child',
          apiKeyHash: await sha256Hex(deterministicApiKey),
        });
        await db.insert(channels).values({
          id: 'bound-channel',
          workspaceId: pair.workspaceId,
          name: 'general',
          topic: 'General discussion',
        });
        await db.insert(workspaceCreateIdempotency).values({
          ownerScopeHash: await sha256Hex(ownerApiKey),
          idempotencyKeyHash: await sha256Hex(idempotencyKey),
          requestDigest,
          workspaceId: pair.workspaceId,
        });
      },
    });

    const result = await createWorkspace(db, 'collision-child', {
      ownerApiKey,
      idempotencyKey,
      requestDigest,
    });

    expect(result.created).toBe(false);
    expect(result.workspace_id).toBe(pair.workspaceId);
    expect(result.api_key).toBe(deterministicApiKey);
  });

  it('canonicalizes provenance field order in workspace-create request digests', async () => {
    const first = await workspaceCreateRequestDigest({
      name: 'canonical-child',
      provenance: { source: 'ci', origin_id: 'run-371', classification: 'internal' },
    });
    const reordered = await workspaceCreateRequestDigest({
      name: 'canonical-child',
      provenance: { classification: 'internal', origin_id: 'run-371', source: 'ci' },
    });

    expect(reordered).toBe(first);
  });

  it('serializes concurrent delegated duplicates and scopes bindings to the owner', async () => {
    attachD1Batch({});
    const requestDigest = await workspaceCreateRequestDigest({ name: 'concurrent-child' });
    const firstOwner = 'rk_live_owner_a';
    const secondOwner = 'rk_live_owner_b';
    const [a, b] = await Promise.all([
      createWorkspace(db, 'concurrent-child', { ownerApiKey: firstOwner, idempotencyKey: 'same-job', requestDigest }),
      createWorkspace(db, 'concurrent-child', { ownerApiKey: firstOwner, idempotencyKey: 'same-job', requestDigest }),
    ]);
    expect(a.workspace_id).toBe(b.workspace_id);
    expect(a.api_key).toBe(b.api_key);
    expect(await db.select().from(workspaces)).toHaveLength(1);

    const otherOwner = await createWorkspace(db, 'concurrent-child', {
      ownerApiKey: secondOwner, idempotencyKey: 'same-job', requestDigest,
    });
    expect(otherOwner.workspace_id).not.toBe(a.workspace_id);
    expect(await db.select().from(workspaces)).toHaveLength(2);
  });

  it('rejects digest conflicts and prevents recreation after child deletion', async () => {
    attachD1Batch({});
    const ownerApiKey = 'rk_live_owner_conflict';
    const key = 'cloud-job-conflict';
    const originalDigest = await workspaceCreateRequestDigest({ name: 'original' });
    const created = await createWorkspace(db, 'original', { ownerApiKey, idempotencyKey: key, requestDigest: originalDigest });
    const changedDigest = await workspaceCreateRequestDigest({ name: 'changed' });
    await expect(createWorkspace(db, 'changed', { ownerApiKey, idempotencyKey: key, requestDigest: changedDigest }))
      .rejects.toMatchObject({ code: 'workspace_create_idempotency_conflict', status: 409 });

    await deleteWorkspace(db, stack.runtime.deps.files, created.workspace_id);
    await expect(createWorkspace(db, 'original', { ownerApiKey, idempotencyKey: key, requestDigest: originalDigest }))
      .rejects.toMatchObject({ code: 'workspace_create_idempotency_terminalized', status: 409 });
    expect(await db.select().from(workspaces)).toHaveLength(0);
    expect(await db.select().from(workspaceCreateIdempotency)).toMatchObject([
      { status: 'terminalized', workspaceId: created.workspace_id },
    ]);
  });

  it('returns storage unavailable when committed-pair readback fails', async () => {
    const batchCalls = attachD1Batch({ loseFirstResponse: true });
    const failingReadbackDb = new Proxy(db, {
      get(target, property) {
        if (property === 'select') {
          return () => {
            throw new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(createWorkspace(failingReadbackDb, 'lost-response-readback-failure')).rejects.toMatchObject({
      code: 'workspace_storage_unavailable',
      status: 503,
    });

    expect(batchCalls()).toBe(2);
    const workspaceRows = await db.select().from(workspaces);
    const channelRows = await db.select().from(channels);
    expect(workspaceRows).toHaveLength(1);
    expect(channelRows).toHaveLength(1);
    expect(channelRows[0]?.workspaceId).toBe(workspaceRows[0]?.id);
  });

  it('recovers a committed workspace when retries after a lost response exhaust', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const batchCalls = attachD1Batch({
      loseFirstResponse: true,
      failAfterLostResponse: true,
    });

    const creation = createWorkspace(db, 'lost-response-exhausted');
    const outcome = creation.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const settled = await outcome;
    if (!settled.ok) throw settled.error;
    const created = settled.value;

    expect(batchCalls()).toBe(5);
    expect(created.api_key).toMatch(/^rk_live_/);
    await expectOneCompleteWorkspace(created.workspace_id);
  });

  it('does not retry a non-transient database error', async () => {
    let calls = 0;
    (db as EngineDb & Partial<BatchCapability>).batch = async () => {
      calls += 1;
      throw new Error('D1_TYPE_ERROR: Type mismatch');
    };

    await expect(createWorkspace(db, 'invalid-write')).rejects.toThrow('D1_TYPE_ERROR');
    expect(calls).toBe(1);
  });

  it('retries a transient D1 workspace deletion and requires an atomic handle', async () => {
    await seedDeletionWorkspace('delete-transient');
    const batchCalls = attachD1Batch({ failBeforeFirst: true });

    await deleteWorkspace(db, stack.runtime.deps.files, 'delete-transient');

    expect(batchCalls()).toBe(2);
    expect(await db.select().from(workspaces)).toHaveLength(0);

    await seedDeletionWorkspace('delete-without-atomicity');
    delete (db as Partial<BatchCapability>).batch;
    await expect(deleteWorkspace(
      db,
      stack.runtime.deps.files,
      'delete-without-atomicity',
    )).rejects.toThrow('Atomic write capability required');
    expect(await db.select().from(workspaces)).toHaveLength(1);
  });

  it('recognizes a committed deletion after transient retries exhaust', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await seedDeletionWorkspace('delete-lost-response');
    const batchCalls = attachD1Batch({
      loseFirstResponse: true,
      failAfterLostResponse: true,
    });

    const deletion = deleteWorkspace(
      db,
      stack.runtime.deps.files,
      'delete-lost-response',
    );
    const outcome = deletion.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.runAllTimersAsync();
    const settled = await outcome;
    if (!settled.ok) throw settled.error;

    expect(batchCalls()).toBe(5);
    expect(await db.select().from(workspaces)).toHaveLength(0);
  });

  it('does not retry a non-transient workspace deletion error', async () => {
    await seedDeletionWorkspace('delete-type-error');
    let calls = 0;
    (db as EngineDb & Partial<BatchCapability>).batch = async () => {
      calls += 1;
      throw new Error('D1_TYPE_ERROR: Type mismatch');
    };

    await expect(deleteWorkspace(
      db,
      stack.runtime.deps.files,
      'delete-type-error',
    )).rejects.toThrow('D1_TYPE_ERROR');
    expect(calls).toBe(1);
    expect(await db.select().from(workspaces)).toHaveLength(1);
  });
});
