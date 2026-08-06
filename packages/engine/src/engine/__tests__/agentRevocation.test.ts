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
import { agents, channels, messages, workspaces } from '../../db/schema.js';
import { SqliteApiKeyAuthProvider, hashToken } from '../../auth/index.js';
import { deleteAgent, revokeAgentToken } from '../agent.js';

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

  it('does not revoke across workspace boundaries', async () => {
    const { db, token } = await seed();

    await expect(revokeAgentToken(db, 'ws_other', 'seat')).resolves.toBeNull();
    expect(await auth.authenticate({ token, require: 'agent', db })).toMatchObject({ ok: true });
  });
});
