/**
 * 1:1 DM conversation identity and roster invariants.
 *
 * A 1:1 conversation id is a pure function of `(workspaceId, sorted agent pair)`,
 * so it names the durable A<->B relationship rather than a conversation instance.
 * Agent Relay has declared that model externally — it is the basis on which Ratify
 * delegation certificates are scoped to a DM (see the Agent Relay Resource
 * Identifier Profile, invariant DM-1), which means the properties asserted here
 * are a compatibility surface, not just internal behaviour.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';

import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { agents, dmConversations, dmParticipants, workspaces } from '../../db/schema.js';
import { sendDm } from '../dm.js';

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

let seq = 0;

interface Fixture {
  db: Db;
  ws: string;
  alice: string;
  bob: string;
}

function seed(): Fixture {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  handles.push(handle);

  const n = ++seq;
  const ws = `ws_${n}`;
  const alice = `ag_alice_${n}`;
  const bob = `ag_bob_${n}`;

  handle.db.insert(workspaces).values({ id: ws, name: `w${n}`, apiKeyHash: `hash_${n}` }).run();
  handle.db.insert(agents).values({ id: alice, workspaceId: ws, name: 'alice', tokenHash: `tok_a_${n}` }).run();
  handle.db.insert(agents).values({ id: bob, workspaceId: ws, name: 'bob', tokenHash: `tok_b_${n}` }).run();

  return { db: handle.db, ws, alice, bob };
}

/** Mirrors `getDmPairKey` — kept independent so a change to the algorithm fails here. */
async function expectedConversationId(ws: string, a: string, b: string): Promise<string> {
  const [first, second] = [a, b].sort();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ws}:${first}:${second}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `dm_${hex.slice(0, 24)}`;
}

describe('1:1 DM conversation identity', () => {
  it('derives the conversation id from the workspace and the sorted agent pair', async () => {
    const { db, ws, alice, bob } = seed();

    const sent = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });

    expect(sent.conversation_id).toBe(await expectedConversationId(ws, alice, bob));
  });

  it('resolves the same conversation regardless of who sends first', async () => {
    const { db, ws, alice, bob } = seed();

    const fromAlice = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    const fromBob = await sendDm(db, ws, bob, { to: 'alice', text: 'hi back' });

    expect(fromBob.conversation_id).toBe(fromAlice.conversation_id);

    const conversations = await db.select().from(dmConversations).where(eq(dmConversations.workspaceId, ws));
    expect(conversations).toHaveLength(1);
  });

  it('re-resolves an existing conversation without creating a second one', async () => {
    const { db, ws, alice } = seed();

    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'one' });
    const second = await sendDm(db, ws, alice, { to: 'bob', text: 'two' });

    expect(second.conversation_id).toBe(first.conversation_id);

    const participants = await db
      .select()
      .from(dmParticipants)
      .where(eq(dmParticipants.conversationId, first.conversation_id));
    expect(participants).toHaveLength(2);
  });
});

describe('invariant DM-1: a 1:1 conversation never has a departed participant', () => {
  /**
   * The seam this pins:
   *
   * `resolveConversation` finds an existing 1:1 by joining `dm_participants`
   * with `left_at IS NULL`. If a participant is ever marked departed the SELECT
   * misses, so the create branch runs — recomputing the *same* deterministic id
   * and re-inserting with `onConflictDoNothing()`, which no-ops against the
   * existing conversation, channel, and participant rows. `left_at` stays set.
   *
   * The conversation therefore keeps resolving correctly while its roster says
   * someone left. Nothing throws; the two just disagree from then on.
   *
   * Identifier stability is not what breaks — the id never consults `left_at`.
   * What breaks is the claim that the identifier names a durable relationship
   * with fixed membership, which is the substance of the lifecycle model Agent
   * Relay declared to Identities AI. That is why this is an invariant and not a
   * code comment.
   *
   * No current code path can set `left_at` for a 1:1 — `left_at` is written only
   * by the group-DM code. This test reaches the state directly so the invariant
   * is guarded before some future path can reach it accidentally.
   */
  it('clears a departed marker rather than resolving a conversation whose roster disagrees', async () => {
    const { db, ws, alice, bob } = seed();

    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    const conversationId = first.conversation_id;

    // Reach the state no current code path can reach.
    await db
      .update(dmParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(eq(dmParticipants.conversationId, conversationId), eq(dmParticipants.agentId, alice)),
      );

    const second = await sendDm(db, ws, alice, { to: 'bob', text: 'again' });

    // Identity holds: the id is a pure function of (workspace, sorted pair).
    expect(second.conversation_id).toBe(conversationId);

    // Exactly one conversation — the create branch must not have minted a second.
    const conversations = await db
      .select()
      .from(dmConversations)
      .where(eq(dmConversations.workspaceId, ws));
    expect(conversations).toHaveLength(1);

    // DM-1 itself: no participant of a 1:1 is left marked departed.
    const departed = await db
      .select()
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, conversationId), isNotNull(dmParticipants.leftAt)));
    expect(departed).toEqual([]);

    // And the roster is still both agents.
    const roster = await db
      .select({ agentId: dmParticipants.agentId })
      .from(dmParticipants)
      .where(eq(dmParticipants.conversationId, conversationId));
    expect(roster.map((r) => r.agentId).sort()).toEqual([alice, bob].sort());
  });
});
