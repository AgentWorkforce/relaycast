import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import { channels, workspaces } from '../../db/schema.js';
import type {
  AtomicWrite,
  BatchCapability,
  EngineDb,
  TransactionCapability,
} from '../../ports/database.js';
import { createWorkspace } from '../workspace.js';

describe('workspace creation durability', () => {
  let stack: TestStack;
  let db: EngineDb;

  beforeEach(() => {
    stack = makeNodeStack();
    db = stack.runtime.handle.db as unknown as EngineDb;
    delete (db as Partial<TransactionCapability>).withTransaction;
  });

  afterEach(() => {
    stack?.close();
  });

  function attachD1Batch(options: {
    failBeforeFirst?: boolean;
    loseFirstResponse?: boolean;
  }): () => number {
    let calls = 0;
    const sqlite = stack.runtime.handle.sqlite;

    (db as EngineDb & Partial<BatchCapability>).batch = async (statements) => {
      calls += 1;
      if (calls === 1 && options.failBeforeFirst) {
        throw new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.');
      }

      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: unknown[] = [];
        for (const statement of statements as ReadonlyArray<AtomicWrite>) {
          results.push(await statement);
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

  it('retries a transient D1 failure and commits workspace plus channel atomically', async () => {
    const batchCalls = attachD1Batch({ failBeforeFirst: true });

    const created = await createWorkspace(db, 'transient-retry');

    expect(batchCalls()).toBe(2);
    await expectOneCompleteWorkspace(created.workspace_id);
  });

  it('replays idempotently when D1 commits but its response is lost', async () => {
    const batchCalls = attachD1Batch({ loseFirstResponse: true });

    const created = await createWorkspace(db, 'lost-response');

    expect(batchCalls()).toBe(2);
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
});
