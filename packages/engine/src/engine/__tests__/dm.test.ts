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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';

import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import {
  agents,
  dmConversationReservations,
  dmConversations,
  dmParticipants,
  workspaces,
} from '../../db/schema.js';
import { isPairReservationConflict, sendDm } from '../dm.js';

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

/** Mirrors the derivation helper — kept independent so an algorithm change fails here. */
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

  /**
   * Migration 0033 deliberately does NOT reserve one-row rosters, because agent
   * deletion cascades `dm_participants` and collapses an ordinary two-party 1:1
   * into a single row whose id still encodes the original pair. Reserving those
   * as (X, X) collided on production data.
   *
   * The safety of skipping them rests entirely on this: an existing, UNRESERVED
   * conversation must be adopted by the first send, not duplicated. A genuine
   * self-DM's id already equals its derivation, so the reservation claims that
   * same id and the conversation is reused.
   *
   * If this ever regressed, every pre-migration self-DM would silently fork into
   * a second conversation on first use and the old history would disappear from
   * the user's view.
   */
  it('adopts an existing unreserved conversation instead of duplicating it', async () => {
    const { db, ws, alice } = seed();

    // Create it, then drop the reservation to model a pre-0033 conversation.
    await sendDm(db, ws, alice, { to: '@self', text: 'before the migration' });
    const original = db.select().from(dmConversations).all();
    expect(original).toHaveLength(1);
    db.delete(dmConversationReservations).run();

    await sendDm(db, ws, alice, { to: '@self', text: 'after the migration' });

    const after = db.select().from(dmConversations).all();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(original[0].id);
    expect(db.select().from(dmConversationReservations).all()).toHaveLength(1);
  });

  /**
   * A self-DM is one roster row, so the reservation stores the same agent as
   * both participants. That has to satisfy the sorted-pair CHECK
   * (participant_one_id <= participant_two_id), which it does only because the
   * comparison is non-strict. Untested before, and `@self` is a documented
   * request shape, so a stricter constraint would have broken a live feature.
   */
  it('reserves a self-DM without violating the sorted-pair constraint', async () => {
    const { db, ws, alice } = seed();
    await sendDm(db, ws, alice, { to: '@self', text: 'note to self' });

    const rows = db.select().from(dmConversationReservations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].participantOneId).toBe(rows[0].participantTwoId);
  });

  /**
   * The reservation and the conversation/roster inserts are NOT one transaction,
   * so a crash between them leaves a reservation with no conversation behind it.
   * That must be self-healing rather than a permanent 409: the retry presents the
   * identical tuple, which the conditional upsert accepts.
   *
   * Asserted rather than assumed. If re-resolution ever stopped accepting an
   * identical tuple, a single mid-write crash would lock that pair out of DMs
   * for good, and nothing else in this suite would notice.
   */
  it('recovers when a reservation outlives its conversation', async () => {
    const { db, ws, alice } = seed();
    await sendDm(db, ws, alice, { to: 'bob', text: 'one' });
    const reserved = db.select().from(dmConversationReservations).all()[0].conversationId;

    db.delete(dmConversations).run(); // conversation gone, reservation remains

    await expect(sendDm(db, ws, alice, { to: 'bob', text: 'two' })).resolves.toBeTruthy();
    expect(db.select().from(dmConversations).all()[0].id).toBe(reserved);
  });

  /**
   * The 409 above must survive the driver change between self-hosted and hosted.
   *
   * This engine has already regressed this exact class once: PR #193 added
   * `isUniqueConstraintError` to agent.ts after clean 409 handling became an
   * uncaught 500 on D1, because detection only matched better-sqlite3's shape.
   * The first version of the reservation handler made the same mistake, and the
   * suite could not see it because the suite runs better-sqlite3.
   *
   * So the shapes are asserted directly rather than only through the send path.
   */
  it('recognises the pair conflict across driver error shapes', () => {
    // better-sqlite3 (what this suite actually runs)
    expect(isPairReservationConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: dm_conversation_reservations.workspace_id',
    })).toBe(true);

    // D1, top level
    expect(isPairReservationConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'D1_ERROR: UNIQUE constraint failed: dm_conversation_reservations.workspace_id',
    })).toBe(true);

    // D1 re-wrapped by drizzle: neither code nor table name at the top level
    expect(isPairReservationConflict({
      message: 'Failed query: insert into "dm_conversation_reservations"',
      cause: {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'D1_ERROR: UNIQUE constraint failed: dm_conversation_reservations.workspace_id',
      },
    })).toBe(true);

    // Split across the chain: code on the wrapper, table name on the cause
    expect(isPairReservationConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'Failed query',
      cause: { message: 'UNIQUE constraint failed: dm_conversation_reservations.workspace_id' },
    })).toBe(true);
  });

  it('does not launder unrelated failures into a pair conflict', () => {
    // A different table's unique violation is not ours.
    expect(isPairReservationConflict({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: observer_tokens.workspace_id',
    })).toBe(false);

    // A non-unique constraint on OUR table is not a pair collision either -
    // reporting a FK failure as a participant-pair conflict would be a lie.
    expect(isPairReservationConflict({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'FOREIGN KEY constraint failed: dm_conversation_reservations.workspace_id',
    })).toBe(false);

    expect(isPairReservationConflict(null)).toBe(false);
    expect(isPairReservationConflict(new Error('boom'))).toBe(false);
  });

  it('terminates on a cyclic cause chain instead of blowing the stack', () => {
    const a: { message: string; cause?: unknown } = { message: 'wrapper a' };
    const b: { message: string; cause?: unknown } = { message: 'wrapper b', cause: a };
    a.cause = b; // A -> B -> A, which a self-reference-only guard would miss
    expect(() => isPairReservationConflict(a)).not.toThrow();
    expect(isPairReservationConflict(a)).toBe(false);
  });

  /**
   * A legacy 1:1 conversation whose id is NOT the current derivation is backfilled
   * by migration 0033 under its own id, so the PAIR is reserved while the
   * deterministic id is not. The next send derives a different conversation_id for
   * the same pair, which violates the pair_unique index rather than the primary
   * key. The upsert only names conversation_id as its conflict target, so that
   * surfaced as a raw SQLITE_CONSTRAINT_UNIQUE (500) instead of the controlled
   * 409 this whole seam exists to produce.
   *
   * Raised in review of PR #303. Failing closed is not enough on its own - it has
   * to fail closed with the documented code, or callers cannot distinguish it
   * from an engine fault.
   */
  it('reports a controlled collision when the pair is reserved under a different id', async () => {
    const { db, ws, alice, bob } = seed();
    const [first, second] = [alice, bob].sort();

    // Simulate the 0033 backfill of a pre-deterministic conversation id.
    db.insert(dmConversationReservations).values({
      conversationId: 'dm_legacy_nondeterministic_id',
      workspaceId: ws,
      participantOneId: first,
      participantTwoId: second,
    }).run();

    let code: string | undefined;
    let status: number | undefined;
    let raw: string | undefined;
    try {
      await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    } catch (err) {
      const e = err as { code?: string; status?: number; message?: string };
      code = e.code;
      status = e.status;
      raw = e.message;
    }

    expect(code, `expected a coded collision, got: ${raw}`).toBe('dm_conversation_id_collision');
    expect(status).toBe(409);
  });

  /**
   * NOTE ON WHAT THIS DOES AND DOES NOT PROVE, raised in review of PR #303.
   *
   * Both real `sendDm` paths are launched before either is awaited, so this
   * exercises the production path with a forced digest collision. But
   * better-sqlite3 is a single synchronous connection, so the two sends
   * serialize and there is no genuine database contention. It proves the
   * collision branch and that the reservation is consulted before any
   * conversation state is created. It does NOT prove multi-writer atomicity
   * against a networked engine.
   *
   * The DB constraint is what makes the operation atomic; this test proves the
   * constraint is load-bearing, which the negative control (dropping to a silent
   * ON CONFLICT DO NOTHING) confirms by producing two winners. Named for what it
   * demonstrates rather than for the mechanism it relies on.
   */
  it('rejects the losing pair when two colliding sends interleave', async () => {
    const { db, ws, alice, bob } = seed();
    const suffix = ws.slice(3);
    const carol = `ag_carol_${suffix}`;
    const dave = `ag_dave_${suffix}`;

    db.insert(agents).values({
      id: carol,
      workspaceId: ws,
      name: 'carol',
      tokenHash: `tok_c_${suffix}`,
    }).run();
    db.insert(agents).values({
      id: dave,
      workspaceId: ws,
      name: 'dave',
      tokenHash: `tok_d_${suffix}`,
    }).run();

    const forcedDigest = new Uint8Array(32).fill(0x5a).buffer;
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(forcedDigest);

    let outcomes: PromiseSettledResult<Awaited<ReturnType<typeof sendDm>>>[];
    try {
      // Deliberately launch both real send paths before awaiting either one.
      outcomes = await Promise.allSettled([
        sendDm(db, ws, alice, { to: 'bob', text: 'alice to bob' }),
        sendDm(db, ws, carol, { to: 'dave', text: 'carol to dave' }),
      ]);
    } finally {
      digestSpy.mockRestore();
    }

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'dm_conversation_id_collision',
      status: 409,
    });

    const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof sendDm>>>).value;
    const roster = await db
      .select({ agentId: dmParticipants.agentId })
      .from(dmParticipants)
      .where(eq(dmParticipants.conversationId, winner.conversation_id));
    const rosterIds = roster.map((row) => row.agentId).sort();
    expect([
      [alice, bob].sort(),
      [carol, dave].sort(),
    ]).toContainEqual(rosterIds);

    const reservations = await db.select().from(dmConversationReservations);
    expect(reservations).toHaveLength(1);
    expect([
      reservations[0].participantOneId,
      reservations[0].participantTwoId,
    ]).toEqual(rosterIds);
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
