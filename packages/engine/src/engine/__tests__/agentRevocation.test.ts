/**
 * Agent credential revocation.
 *
 * The property under test is a NEGATIVE AUTH RECEIPT: the credential is
 * presented and authentication is refused. Nothing weaker counts. An agent being
 * offline, absent from a roster, or the subject of a successful-looking API call
 * are all compatible with a token that still works, so none of them are asserted
 * here — every test drives `authenticate()`, the single lookup that turns an
 * `at_live_` token into an identity.
 *
 * The last block pins down why this primitive exists at all: `deleteAgent`
 * cannot contain a credential on any seat that has posted a message, and the
 * seats it can delete are the ones with no history worth keeping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { agents, channels, messages, nodes, workspaces } from '../../db/schema.js';
import { SqliteApiKeyAuthProvider, hashToken } from '../../auth/index.js';
import { deleteAgent, revokeAgentToken } from '../agent.js';
import { registerAgentViaNode } from '../node.js';

type Db = SqliteDbHandle['db'];

const handles: SqliteDbHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      handle.sqlite.close();
    } catch {
      /* already closed */
    }
  }
});

const auth = new SqliteApiKeyAuthProvider();

let seq = 0;

interface Fixture {
  db: Db;
  ws: string;
  agentId: string;
  /** Synthetic test token. Never a real credential. */
  token: string;
}

async function seed(): Promise<Fixture> {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  handles.push(handle);

  const n = ++seq;
  const ws = `ws_${n}`;
  const agentId = `ag_${n}`;
  const token = `at_live_synthetic_test_value_${n}`;

  handle.db.insert(workspaces).values({ id: ws, name: `w${n}`, apiKeyHash: `hash_${n}` }).run();
  handle.db
    .insert(agents)
    .values({ id: agentId, workspaceId: ws, name: 'seat', tokenHash: await hashToken(token) })
    .run();

  return { db: handle.db, ws, agentId, token };
}

/**
 * Wrap a db so the guarded UPDATE inside `revokeAgentToken` is replaced by
 * `interfere` — the window between reading the active row and writing to it.
 * Everything else passes through to the real database.
 */
function raceDb(db: Db, interfere: () => Promise<void>): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return () => ({
          set: () => ({
            where: () => ({ returning: async () => { await interfere(); return []; } }),
          }),
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

/** Give the seat the audit history that makes it undeletable. */
function givePostHistory(db: Db, ws: string, agentId: string, n: number): void {
  db.insert(channels).values({ id: `ch_${n}`, workspaceId: ws, name: 'general' }).run();
  db.insert(messages)
    .values({ id: `m_${n}`, workspaceId: ws, channelId: `ch_${n}`, agentId, body: 'hello' })
    .run();
}

describe('agent token revocation — negative auth receipt', () => {
  it('authenticates the token before revocation', async () => {
    const { db, token } = await seed();

    const result = await auth.authenticate({ token, require: 'agent', db });

    expect(result.ok).toBe(true);
  });

  it('refuses the same token after revocation', async () => {
    const { db, ws, token } = await seed();

    await revokeAgentToken(db, ws, 'seat');
    const result = await auth.authenticate({ token, require: 'agent', db });

    // This assertion IS the receipt: credential presented, authentication refused.
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      code: 'agent_token_revoked',
    });
  });

  it('reports revoked distinctly from never-existed', async () => {
    const { db, ws, token } = await seed();
    await revokeAgentToken(db, ws, 'seat');

    const revoked = await auth.authenticate({ token, require: 'agent', db });
    const unknown = await auth.authenticate({
      token: 'at_live_synthetic_never_issued',
      require: 'agent',
      db,
    });

    // A deleted row would have reported `agent_token_invalid` — indistinguishable
    // from a token that was never issued. Keeping the record keeps the distinction.
    expect(revoked).toMatchObject({ ok: false, code: 'agent_token_revoked' });
    expect(unknown).toMatchObject({ ok: false, code: 'agent_token_invalid' });
  });

  it('does not revoke unrelated seats in the same workspace', async () => {
    const { db, ws, token } = await seed();
    const peerToken = 'at_live_synthetic_peer_value';
    db.insert(agents)
      .values({ id: 'ag_peer', workspaceId: ws, name: 'peer', tokenHash: await hashToken(peerToken) })
      .run();

    await revokeAgentToken(db, ws, 'seat');

    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({ ok: false });
    expect(await auth.authenticate({ token: peerToken, require: 'agent', db })).toMatchObject({ ok: true });
  });
});

describe('agent token revocation — history survives', () => {
  it('keeps the agent row and its messages', async () => {
    const { db, ws, agentId } = await seed();
    givePostHistory(db, ws, agentId, seq);

    await revokeAgentToken(db, ws, 'seat');

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const posted = await db.select().from(messages).where(eq(messages.agentId, agentId));
    expect(row).toBeDefined();
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(posted).toHaveLength(1);
  });

  it('succeeds on a seat with history, where deletion cannot', async () => {
    const { db, ws, agentId, token } = await seed();
    givePostHistory(db, ws, agentId, seq);

    // The path the operator was originally told to use.
    await expect(deleteAgent(db, ws, 'seat')).rejects.toThrow();

    // The path that works, on the identical seat.
    await expect(revokeAgentToken(db, ws, 'seat')).resolves.toMatchObject({ alreadyRevoked: false });
    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({
      ok: false,
      code: 'agent_token_revoked',
    });
  });
});

describe('agent token revocation — survives re-registration', () => {
  /**
   * `registerAgentViaNode` upserts on `(workspace_id, name)` and its `setWhere`
   * fires for any seat whose status is not 'active'. Its `set` clause rewrites
   * `token_hash`, so a containment marker stored *in that column* — a sentinel
   * hash, say — is silently overwritten the next time any node registers the
   * name, and the seat comes back live.
   *
   * `revoked_at` is not in that `set` clause. This test is what holds that true:
   * if someone adds it, containment becomes undoable by a heartbeat and this
   * fails. Do not "fix" it by clearing `revoked_at` on registration.
   */
  it('a node re-registering the name does not resurrect a revoked credential', async () => {
    const { db, ws, agentId, token } = await seed();
    await revokeAgentToken(db, ws, 'seat');

    // An *offline* seat is what makes the upsert fire: `setWhere` matches on
    // `status != 'active'`, so any node can reclaim the name — not just the one
    // the seat was bound to. Four of the seats this was built for are offline.
    db.update(agents).set({ status: 'offline' }).where(eq(agents.id, agentId)).run();
    db.insert(nodes)
      .values({ id: 'nd_1', workspaceId: ws, name: 'node-1', tokenHash: 'node-hash-1' })
      .run();

    // Same workspace, same name — the upsert path, on an offline seat.
    const reregistered = await registerAgentViaNode(db, ws, 'nd_1', 'default', {
      name: 'seat',
    } as Parameters<typeof registerAgentViaNode>[4]);

    // Registration hands back a fresh token, and `token_hash` really was rewritten.
    expect(reregistered.token).toBeTruthy();

    // But the seat stays contained: the marker survived, so the brand-new
    // credential is refused exactly like the old one.
    const [row] = await db.select().from(agents).where(eq(agents.workspaceId, ws));
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(await auth.authenticate({ token: reregistered.token, require: 'agent', db })).toMatchObject({
      ok: false,
      code: 'agent_token_revoked',
    });
    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({ ok: false });
  });
});

describe('agent token revocation — operational properties', () => {
  it('is idempotent and preserves the original timestamp', async () => {
    const { db, ws } = await seed();

    const first = await revokeAgentToken(db, ws, 'seat');
    const second = await revokeAgentToken(db, ws, 'seat');

    // An operator re-running the runbook must not be able to rewrite when
    // containment actually took effect.
    expect(first).toMatchObject({ alreadyRevoked: false });
    expect(second).toMatchObject({ alreadyRevoked: true });
    expect(second!.revokedAt.getTime()).toBe(first!.revokedAt.getTime());
  });

  it('returns null for an unknown agent rather than inventing a receipt', async () => {
    const { db, ws } = await seed();

    await expect(revokeAgentToken(db, ws, 'no-such-seat')).resolves.toBeNull();
  });

  it('issues no receipt when the row is deleted mid-operation', async () => {
    const { db, ws, agentId } = await seed();

    // The row disappears between the initial read and the guarded update, so the
    // update matches nothing and there is no persisted `revoked_at` to report.
    // Returning a locally-generated timestamp here would be a receipt for a
    // revocation that never happened.
    const raced = raceDb(db, async () => {
      await db.delete(agents).where(eq(agents.id, agentId));
    });

    await expect(revokeAgentToken(raced, ws, 'seat')).resolves.toBeNull();
  });

  it('issues no receipt when the update does not land', async () => {
    const { db, ws, token } = await seed();

    const swallowed = raceDb(db, async () => {
      /* drop the write on the floor */
    });

    await expect(revokeAgentToken(swallowed, ws, 'seat')).resolves.toBeNull();
    // And the credential must still work — no silent half-revocation.
    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({ ok: true });
  });

  it('marks the loser of a concurrent revoke as already revoked', async () => {
    const { db, ws } = await seed();

    // Another operator's revoke lands after this call has read the active row,
    // so this call's guarded update matches nothing. Both used to claim to have
    // performed the fresh revocation.
    let other: Date | undefined;
    const raced = raceDb(db, async () => {
      other = new Date(Date.now() - 1000);
      await db.update(agents).set({ revokedAt: other }).where(eq(agents.workspaceId, ws));
    });

    const result = await revokeAgentToken(raced, ws, 'seat');

    expect(result).toMatchObject({ alreadyRevoked: true });
    expect(result!.revokedAt.getTime()).toBe(Math.floor(other!.getTime() / 1000) * 1000);
  });

  it('does not revoke across workspace boundaries', async () => {
    const { db, token } = await seed();

    await expect(revokeAgentToken(db, 'ws_other', 'seat')).resolves.toBeNull();
    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({ ok: true });
  });
});
