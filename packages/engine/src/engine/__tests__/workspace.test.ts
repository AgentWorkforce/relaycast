import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import { channels, workspaceCreateIdempotency, workspaces } from '../../db/schema.js';
import { sha256Hex } from '../../lib/crypto.js';
import type {
  AtomicWrite,
  BatchCapability,
  EngineDb,
  TransactionCapability,
} from '../../ports/database.js';
import * as snowflake from '../snowflake.js';
import {
  createWorkspace,
  deleteWorkspace,
  deriveBootstrapWorkspaceApiKey,
  deriveIdempotentWorkspaceApiKey,
  MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH,
  workspaceCreateRequestDigest,
} from '../workspace.js';

// Fixture-only padding, not a real secret: guarantees every anonymous
// bootstrap Idempotency-Key literal below clears MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH
// while staying readable. Owner-scoped keys in this file are unaffected by
// the floor and are left short.
const ENTROPY_PAD = '9f3a7c1e5b8d2f4a6c0e8b2d4f6a8c0e';
function anonKey(label: string): string {
  const key = `${label}:${ENTROPY_PAD}`;
  if (key.length < MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`test fixture key too short: ${key}`);
  }
  return key;
}

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

  it('recovers an anonymous bootstrap key after commit/response loss', async () => {
    const batchCalls = attachD1Batch({ loseFirstResponse: true });
    const bootstrapSecret = 'test-bootstrap-secret';
    const idempotencyKey = anonKey('bootstrap-recovery-379');
    const requestDigest = await workspaceCreateRequestDigest({ name: 'bootstrap-child', expiresInSeconds: 3_600 });
    const created = await createWorkspace(db, 'bootstrap-child', {
      bootstrapSecret,
      bootstrapSecretProof: bootstrapSecret,
      idempotencyKey,
      requestDigest,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(batchCalls()).toBe(2);
    expect(created.created).toBe(true);
    expect(created.api_key).toBe(await deriveBootstrapWorkspaceApiKey(bootstrapSecret, idempotencyKey, requestDigest));
    expect(await db.select().from(workspaces)).toHaveLength(1);
    expect(await db.select().from(workspaceCreateIdempotency)).toHaveLength(1);

    const replay = await createWorkspace(db, 'bootstrap-child', {
      bootstrapSecret,
      bootstrapSecretProof: bootstrapSecret,
      idempotencyKey,
      requestDigest,
    });
    expect(replay.created).toBe(false);
    expect(replay.workspace_id).toBe(created.workspace_id);
    expect(replay.api_key).toBe(created.api_key);
  });

  it('isolates bootstrap bindings from owner bindings and rejects digest conflicts', async () => {
    attachD1Batch({});
    const bootstrapSecret = 'test-bootstrap-secret';
    const idempotencyKey = anonKey('same-key-379');
    const requestDigest = await workspaceCreateRequestDigest({ name: 'bootstrap-isolation' });
    const bootstrap = await createWorkspace(db, 'bootstrap-isolation', {
      bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest,
    });
    const owner = await createWorkspace(db, 'owner-isolation', {
      ownerApiKey: 'rk_live_owner_379', idempotencyKey, requestDigest,
    });
    expect(owner.workspace_id).not.toBe(bootstrap.workspace_id);
    expect(owner.api_key).not.toBe(bootstrap.api_key);

    const changedDigest = await workspaceCreateRequestDigest({ name: 'bootstrap-changed' });
    await expect(createWorkspace(db, 'bootstrap-changed', {
      bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest: changedDigest,
    })).rejects.toMatchObject({ code: 'workspace_create_idempotency_conflict', status: 409 });
    expect(await db.select().from(workspaces)).toHaveLength(2);
  });

  it('serializes concurrent anonymous bootstrap duplicates', async () => {
    attachD1Batch({});
    const bootstrapSecret = 'test-bootstrap-secret';
    const idempotencyKey = anonKey('bootstrap-concurrent-379');
    const requestDigest = await workspaceCreateRequestDigest({ name: 'bootstrap-concurrent' });
    const [first, second] = await Promise.all([
      createWorkspace(db, 'bootstrap-concurrent', { bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest }),
      createWorkspace(db, 'bootstrap-concurrent', { bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest }),
    ]);
    expect(first.workspace_id).toBe(second.workspace_id);
    expect(first.api_key).toBe(second.api_key);
    expect(await db.select().from(workspaces)).toHaveLength(1);
    expect(await db.select().from(channels)).toHaveLength(1);
    expect(await db.select().from(workspaceCreateIdempotency)).toHaveLength(1);
  });

  it('rejects an anonymous bootstrap replay that cannot prove the deployment secret', async () => {
    attachD1Batch({});
    const bootstrapSecret = 'test-bootstrap-secret';
    const idempotencyKey = anonKey('squatting-attempt-379');
    const requestDigest = await workspaceCreateRequestDigest({ name: 'squatting-target' });

    // The legitimate caller creates the workspace, proving the secret.
    const created = await createWorkspace(db, 'squatting-target', {
      bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest,
    });
    expect(created.created).toBe(true);

    // An attacker who has only observed/guessed the same idempotency key and
    // request digest -- both non-secret, attacker-computable values -- must
    // not be able to retrieve the workspace or its API key without also
    // proving the deployment's bootstrap secret.
    await expect(createWorkspace(db, 'squatting-target', {
      bootstrapSecret, idempotencyKey, requestDigest, // no bootstrapSecretProof
    })).rejects.toMatchObject({ code: 'workspace_create_bootstrap_secret_invalid', status: 401 });

    await expect(createWorkspace(db, 'squatting-target', {
      bootstrapSecret, bootstrapSecretProof: 'wrong-secret', idempotencyKey, requestDigest,
    })).rejects.toMatchObject({ code: 'workspace_create_bootstrap_secret_invalid', status: 401 });

    // A first-time attacker create attempt under the same key must also fail
    // closed rather than falling through to create its own workspace: an
    // unproven caller must never influence bootstrap-scoped state at all.
    await expect(createWorkspace(db, 'attacker-would-create', {
      bootstrapSecret,
      idempotencyKey: anonKey('never-created-379'),
      requestDigest: await workspaceCreateRequestDigest({ name: 'attacker-would-create' }),
    })).rejects.toMatchObject({ code: 'workspace_create_bootstrap_secret_invalid', status: 401 });
    expect(await db.select().from(workspaces)).toHaveLength(1);

    // The legitimate caller can still replay indefinitely -- e.g. across
    // container restarts -- as long as it keeps presenting the same secret.
    const replay = await createWorkspace(db, 'squatting-target', {
      bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest,
    });
    expect(replay.created).toBe(false);
    expect(replay.api_key).toBe(created.api_key);
  });

  it('rejects an anonymous bootstrap Idempotency-Key below the structural floor, even with the correct secret', async () => {
    attachD1Batch({});
    const bootstrapSecret = 'test-bootstrap-secret';
    const requestDigest = await workspaceCreateRequestDigest({ name: 'weak-key-target' });

    // A guessable/short key is rejected on shape alone -- before any DB work
    // or secret comparison -- regardless of whether the caller happens to
    // also present the correct deployment secret. relaycast#379: the key
    // itself must satisfy the structural floor, not just be paired with a secret header.
    for (const weakKey of [
      'a',
      'job-123',
      'bootstrap:run-1',
      'x'.repeat(MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH - 1),
    ]) {
      await expect(createWorkspace(db, 'weak-key-target', {
        bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey: weakKey, requestDigest,
      })).rejects.toMatchObject({
        code: 'workspace_create_idempotency_key_too_weak',
        status: 400,
        message: expect.stringContaining('at least 24 random bytes base64url-encoded'),
      });
    }
    expect(await db.select().from(workspaces)).toHaveLength(0);

    // Control: a key of exactly the floor length, with the correct secret,
    // succeeds -- the floor rejects shape, not legitimate high-entropy keys.
    const created = await createWorkspace(db, 'weak-key-target', {
      bootstrapSecret,
      bootstrapSecretProof: bootstrapSecret,
      idempotencyKey: 'x'.repeat(MIN_BOOTSTRAP_IDEMPOTENCY_KEY_LENGTH),
      requestDigest,
    });
    expect(created.created).toBe(true);
  });

  it('does not weaken an attacker replay attempt just because the guessed key happens to be long enough', async () => {
    // An attacker who can construct a long-enough (but still guessed) key
    // still cannot pass the bootstrap-secret proof: the structural floor and
    // the secret proof are independent, both-required checks, not
    // alternatives to each other.
    attachD1Batch({});
    const bootstrapSecret = 'test-bootstrap-secret';
    const idempotencyKey = anonKey('long-enough-guessed-key-379');
    const requestDigest = await workspaceCreateRequestDigest({ name: 'long-guess-target' });

    const created = await createWorkspace(db, 'long-guess-target', {
      bootstrapSecret, bootstrapSecretProof: bootstrapSecret, idempotencyKey, requestDigest,
    });
    expect(created.created).toBe(true);

    await expect(createWorkspace(db, 'long-guess-target', {
      bootstrapSecret, idempotencyKey, requestDigest, // correct length, no proof
    })).rejects.toMatchObject({ code: 'workspace_create_bootstrap_secret_invalid', status: 401 });
    expect(await db.select().from(workspaces)).toHaveLength(1);
  });

  it('does not treat an unrelated workspace-id collision as own recovery', async () => {
    const ownerApiKey = 'rk_live_collision_owner';
    const idempotencyKey = 'collision-job';
    const requestDigest = await workspaceCreateRequestDigest({ name: 'collision-child' });
    const deterministicApiKey = await deriveIdempotentWorkspaceApiKey(ownerApiKey, idempotencyKey, requestDigest);
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

  it('fails closed when binding recovery cannot verify the committed pair', async () => {
    const ownerApiKey = 'rk_live_readback_owner';
    const idempotencyKey = 'readback-job';
    const requestDigest = await workspaceCreateRequestDigest({ name: 'readback-child' });
    // The first atomic write commits, but its response is lost. The retry then
    // reaches generated-pair readback before it can classify the replay.
    attachD1Batch({ loseFirstResponse: true });

    const failingReadbackDb = new Proxy(db, {
      get(target, property) {
        if (property === 'select') {
          return (...args: Parameters<EngineDb['select']>) => {
            const query = target.select(...args) as unknown as {
              from(table: unknown): unknown;
            };
            const originalFrom = query.from.bind(query);
            return new Proxy(query, {
              get(queryTarget, queryProperty, receiver) {
                if (queryProperty === 'from') {
                  return (table: unknown) => {
                    if (table === channels) throw new Error('readback query unavailable');
                    return originalFrom(table);
                  };
                }
                return Reflect.get(queryTarget, queryProperty, receiver);
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(createWorkspace(failingReadbackDb, 'readback-child', {
      ownerApiKey,
      idempotencyKey,
      requestDigest,
    })).rejects.toMatchObject({
      code: 'workspace_storage_unavailable',
      status: 503,
      diagnostics: {
        operation: 'workspace.create',
        storage_error: 'readback_unavailable',
      },
    });
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
