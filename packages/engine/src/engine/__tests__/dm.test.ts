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
import { and, eq, isNotNull, mapResultRow } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { brandSqliteEngineDb } from '../../adapters/sqlite-handle.js';
import * as schema from '../../db/tables.js';
import {
  a2aAgents,
  a2aEgress,
  agents,
  channels,
  directDmIdempotency,
  dmConversationReservations,
  dmConversations,
  dmParticipants,
  messages,
  nodes,
  pendingEvents,
  workspaceEvents,
  workspaces,
} from '../../db/tables.js';
import { isPairReservationConflict, sendDm } from '../dm.js';
import {
  DIRECT_DM_IDEMPOTENCY_CLEANUP_BATCH_SIZE,
  expireA2aEgressForReuse,
  sweepPendingA2aEgress,
} from '../a2aEgress.js';
import { sha256Hex } from '../../lib/crypto.js';
import { runIndependentReads } from '../../ports/database.js';
import { a2aAgentByRelayNameQuery, a2aAgentFromRows, getA2aAgentByRelayName } from '../a2a.js';

type Db = SqliteDbHandle['db'];

const handles: SqliteDbHandle[] = [];

afterEach(() => {
  vi.useRealTimers();
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
  sqlite: SqliteDbHandle['sqlite'];
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

  return { db: handle.db, sqlite: handle.sqlite, ws, alice, bob };
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

  it('admits two concurrent dispatch attempts with one idempotency key as one stored message', async () => {
    const { db, ws, alice } = seed();
    const request = { to: 'bob', text: 'only once' };
    let transactionArrivals = 0;
    let releaseAdmissions!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmissions = resolve; });
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'withTransaction') {
          return async <T>(fn: Parameters<NonNullable<Db['withTransaction']>>[0]): Promise<T> => {
            transactionArrivals += 1;
            if (transactionArrivals === 2) releaseAdmissions();
            await admissionGate;
            return target.withTransaction(fn) as Promise<T>;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const [first, second] = await Promise.all([
      sendDm(racingDb, ws, alice, request, { idempotencyKey: 'logical-dm-1' }),
      sendDm(racingDb, ws, alice, request, { idempotencyKey: 'logical-dm-1' }),
    ]);

    expect(second.id).toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(1);
    const outbox = db.select().from(pendingEvents).all();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].maxAttempts).toBe(32);
    expect(db.select().from(workspaceEvents).all()).toHaveLength(1);
  });

  it('keeps one keyed request claim when a recipient changes to A2A routing', async () => {
    const { db, ws, alice, bob } = seed();
    const request = { to: 'bob', text: 'same request' };
    const first = await sendDm(db, ws, alice, request, { idempotencyKey: 'transport-change' });

    await db.insert(a2aAgents).values({
      id: 'a2a_transport_change',
      workspaceId: ws,
      relayAgentId: bob,
      agentCard: {
        name: 'bob',
        url: 'https://example.com/a2a/rpc',
        version: '1.0.0',
        skills: [{ id: 'echo', name: 'echo' }],
      },
      externalUrl: 'https://example.com/a2a/rpc',
    });

    const replay = await sendDm(db, ws, alice, request, { idempotencyKey: 'transport-change' });
    expect(replay.id).toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(1);
    expect(db.select().from(a2aEgress).all()).toHaveLength(0);
  });

  it('reports a fresh claim TTL after post-admission work completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const acceptedAt = new Date('2026-10-02T00:00:00.000Z');
    vi.setSystemTime(acceptedAt);
    const { db, ws, alice } = seed();

    const sent = await sendDm(db, ws, alice, { to: 'bob', text: 'slow completion' }, {
      idempotencyKey: 'fresh-claim-ttl',
      afterAdmission: () => vi.setSystemTime(acceptedAt.getTime() + 5_000),
    });

    expect(sent._idempotency_ttl_seconds).toBe(24 * 60 * 60 - 5);
  });

  it('prunes expired keyed request claims without deleting their messages', async () => {
    const { db, ws, alice } = seed();
    await sendDm(db, ws, alice, { to: 'bob', text: 'retained' }, {
      idempotencyKey: 'expired-claim',
    });
    const [claim] = db.select({ id: directDmIdempotency.id }).from(directDmIdempotency).all();
    await db.update(directDmIdempotency)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(directDmIdempotency.id, claim!.id));

    expect(await sweepPendingA2aEgress(db, 20)).toEqual({ attempted: 0, failed: 0 });
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(0);
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it('prunes direct request claims with its own bounded budget across sweeps', async () => {
    const { db, ws } = seed();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const count = DIRECT_DM_IDEMPOTENCY_CLEANUP_BATCH_SIZE + 1;
    for (let i = 0; i < count; i += 1) {
      db.insert(directDmIdempotency).values({
        id: `dmid_expired_${i}`,
        workspaceId: ws,
        messageId: `msg_expired_${i}`,
        fingerprint: `fingerprint_${i}`,
        response: { id: `msg_expired_${i}` },
        createdAt: old,
      }).run();
    }

    // The A2A work budget is deliberately tiny; direct claims still consume
    // their independent 500-row batch and never turn this into an unbounded delete.
    expect(await sweepPendingA2aEgress(db, 2)).toEqual({ attempted: 0, failed: 0 });
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(1);
    expect(await sweepPendingA2aEgress(db, 2)).toEqual({ attempted: 0, failed: 0 });
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(0);
  });

  it('rejects reuse of a direct-DM idempotency key for a different payload', async () => {
    const { db, ws, alice } = seed();
    await sendDm(db, ws, alice, { to: 'bob', text: 'first' }, { idempotencyKey: 'logical-dm-2' });

    await expect(
      sendDm(db, ws, alice, { to: 'bob', text: 'changed' }, { idempotencyKey: 'logical-dm-2' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it('replays reordered nested metadata as the same keyed request', async () => {
    const { db, ws, alice } = seed();
    const first = await sendDm(db, ws, alice, {
      to: 'bob',
      text: 'metadata',
      data: { outer: { beta: 2, alpha: 1 }, tail: true },
    }, { idempotencyKey: 'canonical-metadata' });
    const replay = await sendDm(db, ws, alice, {
      to: 'bob',
      text: 'metadata',
      data: { tail: true, outer: { alpha: 1, beta: 2 } },
    }, { idempotencyKey: 'canonical-metadata' });

    expect(replay.id).toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it('returns the stored receipt while an accepted A2A egress has a live lease', async () => {
    const { db, ws, alice } = seed();
    const key = 'a2a-live-replay';
    const request = { to: 'bob', text: 'accepted' };
    const first = await sendDm(db, ws, alice, request, { idempotencyKey: key });
    const egressId = `a2ae_${await sha256Hex(JSON.stringify([ws, alice, key]))}`;
    await db.insert(a2aEgress).values({
      id: egressId,
      workspaceId: ws,
      messageId: first.id,
      targetId: 'a2a-target',
      externalUrl: 'https://example.com/a2a/rpc',
      fingerprint: await sha256Hex(JSON.stringify(request)),
      status: 'sending',
      claimToken: 'live-owner',
      leaseUntil: new Date(Date.now() + 60_000),
    });

    const replay = await sendDm(db, ws, alice, request, { idempotencyKey: key });
    expect(replay.id).toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(db.select().from(a2aEgress).all()).toHaveLength(1);
  });

  it('replays a terminal A2A outcome after the request claim commits', async () => {
    const { db, ws, alice } = seed();
    const key = 'a2a-terminal-replay';
    const request = { to: 'bob', text: 'accepted then rejected' };
    const first = await sendDm(db, ws, alice, request, { idempotencyKey: key });
    const egressId = `a2ae_${await sha256Hex(JSON.stringify([ws, alice, key]))}`;
    await db.insert(a2aEgress).values({
      id: egressId,
      workspaceId: ws,
      messageId: first.id,
      targetId: 'a2a-target',
      externalUrl: 'https://example.com/a2a/rpc',
      fingerprint: await sha256Hex(JSON.stringify(request)),
      status: 'failed',
      lastError: 'upstream refused',
      errorStatus: 403,
      errorCode: 'a2a_upstream_rejected',
    });

    await expect(sendDm(db, ws, alice, request, { idempotencyKey: key }))
      .rejects.toMatchObject({ status: 403, code: 'a2a_upstream_rejected' });
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it('validates source retention before replaying a settled A2A receipt', async () => {
    const { db, ws, alice } = seed();
    const key = 'a2a-retention-replay';
    const request = { to: 'bob', text: 'retained only with source' };
    const first = await sendDm(db, ws, alice, request, { idempotencyKey: key });
    const egressId = `a2ae_${await sha256Hex(JSON.stringify([ws, alice, key]))}`;
    await db.insert(a2aEgress).values({
      id: egressId,
      workspaceId: ws,
      messageId: first.id,
      targetId: 'a2a-target',
      externalUrl: 'https://example.com/a2a/rpc',
      fingerprint: await sha256Hex(JSON.stringify(request)),
      status: 'sent',
    });
    await db.delete(messages).where(eq(messages.id, first.id));

    await expect(sendDm(db, ws, alice, request, { idempotencyKey: key }))
      .rejects.toMatchObject({ status: 410, code: 'a2a_message_not_retained' });
  });

  it('expires a retained A2A identity before reusing an expired request key', async () => {
    const { db, ws, alice } = seed();
    const key = 'expired-a2a-identity';
    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'old' }, {
      idempotencyKey: key,
    });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const [claim] = db.select({ id: directDmIdempotency.id }).from(directDmIdempotency).all();
    await db.update(directDmIdempotency).set({ createdAt: old })
      .where(eq(directDmIdempotency.id, claim!.id));
    const egressId = `a2ae_${await sha256Hex(JSON.stringify([ws, alice, key]))}`;
    await db.insert(a2aEgress).values({
      id: egressId,
      workspaceId: ws,
      messageId: first.id,
      targetId: 'retired-a2a-target',
      externalUrl: 'https://example.com/a2a/rpc',
      fingerprint: 'expired',
      status: 'sent',
      createdAt: old,
    });

    const fresh = await sendDm(db, ws, alice, { to: 'bob', text: 'fresh' }, {
      idempotencyKey: key,
    });
    expect(fresh.id).not.toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(2);
    expect(db.select().from(a2aEgress).all()).toHaveLength(0);
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(1);
  });

  it('preserves an expired A2A identity while its transport lease is live', async () => {
    const { db, ws, alice } = seed();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const id = 'a2ae_live_lease';
    await db.insert(a2aEgress).values({
      id,
      workspaceId: ws,
      messageId: 'msg_live_lease',
      targetId: 'a2a-target',
      externalUrl: 'https://example.com/a2a/rpc',
      fingerprint: 'fingerprint',
      status: 'sending',
      leaseUntil: new Date(Date.now() + 60_000),
      createdAt: old,
    });

    expect(await expireA2aEgressForReuse(db, id)).toBe(false);
    expect(db.select().from(a2aEgress).all()).toHaveLength(1);
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

describe('1:1 DM resolution fast path', () => {
  const RESOLUTION_TABLES = ['dm_conversation_reservations', 'channels', 'dm_conversations', 'dm_participants'];

  /** Record every SQL statement the connection prepares while `run` executes. */
  async function captureStatements(sqlite: Fixture['sqlite'], run: () => Promise<unknown>): Promise<string[]> {
    const statements: string[] = [];
    const original = sqlite.prepare.bind(sqlite);
    const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
      statements.push(source);
      return original(source);
    }) as typeof sqlite.prepare);
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return statements;
  }

  /** INSERT/UPDATE statements whose target is one of the resolution tables. */
  function resolutionWrites(statements: string[]): string[] {
    return statements.filter((statement) => {
      const match = /^\s*(?:insert\s+into|update)\s+"?([a-z_]+)"?/i.exec(statement);
      return match !== null && RESOLUTION_TABLES.includes(match[1]);
    });
  }

  it('resolves a repeat send without writing reservation, channel, conversation or roster rows', async () => {
    const { db, sqlite, ws, alice } = seed();
    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'one' });

    let second: Awaited<ReturnType<typeof sendDm>> | undefined;
    const statements = await captureStatements(sqlite, async () => {
      second = await sendDm(db, ws, alice, { to: 'bob', text: 'two' });
    });

    expect(second?.conversation_id).toBe(first.conversation_id);
    expect(resolutionWrites(statements)).toEqual([]);
    // The message itself is still written.
    expect(statements.some((statement) => /^\s*insert\s+into\s+"messages"/i.test(statement))).toBe(true);
  });

  it('takes the fast path from either direction and for a self-DM', async () => {
    const { db, sqlite, ws, alice, bob } = seed();
    await sendDm(db, ws, alice, { to: 'bob', text: 'one' });
    await sendDm(db, ws, alice, { to: '@self', text: 'note' });

    const fromBob = await captureStatements(sqlite, () => sendDm(db, ws, bob, { to: 'alice', text: 'reply' }));
    const self = await captureStatements(sqlite, () => sendDm(db, ws, alice, { to: '@self', text: 'note 2' }));

    expect(resolutionWrites(fromBob)).toEqual([]);
    expect(resolutionWrites(self)).toEqual([]);
  });

  it('creates every resolution row on the first send between a new pair', async () => {
    const { db, sqlite, ws, alice, bob } = seed();

    let sent: Awaited<ReturnType<typeof sendDm>> | undefined;
    const statements = await captureStatements(sqlite, async () => {
      sent = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    });

    const writtenTables = new Set(resolutionWrites(statements).map((s) => /"([a-z_]+)"/.exec(s)![1]));
    expect([...writtenTables].sort()).toEqual([...RESOLUTION_TABLES].sort());

    const conversationId = sent!.conversation_id;
    expect(db.select().from(dmConversationReservations).all()).toHaveLength(1);
    const [conv] = db.select().from(dmConversations).where(eq(dmConversations.id, conversationId)).all();
    expect(conv).toBeDefined();
    expect(db.select().from(channels).where(eq(channels.id, conv.channelId)).all()).toHaveLength(1);
    const roster = db.select().from(dmParticipants).where(eq(dmParticipants.conversationId, conversationId)).all();
    expect(roster.map((r) => r.agentId).sort()).toEqual([alice, bob].sort());
  });

  it('falls back to the write path and rejoins a departed participant', async () => {
    const { db, sqlite, ws, alice, bob } = seed();
    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    await db
      .update(dmParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(dmParticipants.conversationId, first.conversation_id), eq(dmParticipants.agentId, bob)));

    const statements = await captureStatements(sqlite, () => sendDm(db, ws, alice, { to: 'bob', text: 'again' }));

    expect(resolutionWrites(statements).some((s) => /"dm_participants"/.test(s))).toBe(true);
    const departed = db
      .select()
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, first.conversation_id), isNotNull(dmParticipants.leftAt)))
      .all();
    expect(departed).toEqual([]);

    // Once healed, the next send is back on the fast path.
    const healed = await captureStatements(sqlite, () => sendDm(db, ws, alice, { to: 'bob', text: 'third' }));
    expect(resolutionWrites(healed)).toEqual([]);
  });

  it('falls back to the write path and recreates a missing channel row', async () => {
    const { db, sqlite, ws, alice } = seed();
    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });
    const [conv] = db.select().from(dmConversations).where(eq(dmConversations.id, first.conversation_id)).all();
    // Model a lost channel row without cascading away the conversation.
    sqlite.pragma('foreign_keys = OFF');
    db.delete(channels).where(eq(channels.id, conv.channelId)).run();
    sqlite.pragma('foreign_keys = ON');

    const statements = await captureStatements(sqlite, () => sendDm(db, ws, alice, { to: 'bob', text: 'again' }));

    expect(resolutionWrites(statements).some((s) => /"channels"/.test(s))).toBe(true);
    expect(db.select().from(channels).where(eq(channels.id, conv.channelId)).all()).toHaveLength(1);
  });

  it('does not let a reservation for a different pair under the derived id reach the fast path', async () => {
    const { db, ws, alice } = seed();
    const first = await sendDm(db, ws, alice, { to: 'bob', text: 'hello' });

    // Rewrite the reservation to a different pair while every other row stays,
    // so only the reservation tuple check stands between the send and a stale hit.
    const [one, two] = [alice, `ag_zz_other_${ws}`].sort();
    db.update(dmConversationReservations)
      .set({ participantOneId: one, participantTwoId: two })
      .where(eq(dmConversationReservations.conversationId, first.conversation_id))
      .run();

    await expect(sendDm(db, ws, alice, { to: 'bob', text: 'again' })).rejects.toMatchObject({
      code: 'dm_conversation_id_collision',
      status: 409,
    });
  });
});

describe('1:1 DM send read batching on a D1-style handle', () => {
  /**
   * A D1 stand-in over the fixture's connection: `batch()` and no
   * `withTransaction`, like drizzle's D1 handle. Like D1 it applies a batch
   * in one transaction. `trips` logs each request: one entry per statement
   * run outside a batch, one `batch[...]` entry per batch call.
   */
  function d1Fixture() {
    const fixture = seed();
    const { sqlite } = fixture;
    const trips: string[] = [];
    let inBatch = false;
    const base = brandSqliteEngineDb(drizzle(sqlite, { schema }));
    const d1 = Object.assign(base, {
      batch: async (statements: readonly PromiseLike<unknown>[]) => {
        trips.push(`batch[${statements.map((statement) => tableOf((statement as unknown as { toSQL(): { sql: string } }).toSQL().sql)).join(',')}]`);
        inBatch = true;
        sqlite.exec('BEGIN');
        try {
          const results: unknown[] = [];
          for (const statement of statements) results.push(await d1BatchResult(statement));
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        } finally {
          inBatch = false;
        }
      },
    }) as unknown as Db;
    /**
     * Map a batched statement's rows the way drizzle's D1 `batch()` does: D1
     * returns rows as objects keyed by output column name, and drizzle turns
     * them into arrays with `Object.keys(row)` (d1ToRawMapping). Two output
     * columns with one name collapse into one key, so the row loses a column
     * and every later field shifts.
     */
    async function d1BatchResult(statement: PromiseLike<unknown>): Promise<unknown> {
      const query = statement as unknown as {
        _prepare(): {
          fields?: Parameters<typeof mapResultRow>[0];
          joinsNotNullableMap?: Record<string, boolean>;
          customResultMapper?: (rows: unknown[][]) => unknown;
        };
        toSQL(): { sql: string; params: unknown[] };
      };
      const { fields, joinsNotNullableMap, customResultMapper } = query._prepare();
      if (!fields && !customResultMapper) return await statement;
      const { sql: source, params } = query.toSQL();
      const objects = sqlite.prepare(source).all(...params) as Array<Record<string, unknown>>;
      const rows = objects.map((row) => Object.keys(row).map((key) => row[key]));
      if (customResultMapper) return customResultMapper(rows);
      return rows.map((row) => mapResultRow(fields!, row, joinsNotNullableMap));
    }
    const original = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
      if (!inBatch && !/^\s*(?:BEGIN|COMMIT|ROLLBACK)/i.test(source)) trips.push(tableOf(source));
      return original(source);
    }) as typeof sqlite.prepare);
    return { ...fixture, d1, trips };
  }

  /** `select:<table>` / `insert:<table>` / ... for the statement's target table. */
  function tableOf(source: string): string {
    const write = /^\s*(insert\s+into|update|delete\s+from)\s+"([a-z_0-9]+)"/i.exec(source);
    if (write) return `${write[1].split(/\s+/)[0].toLowerCase()}:${write[2]}`;
    const read = /\bfrom\s+"([a-z_0-9]+)"/i.exec(source);
    return `select:${read ? read[1] : '?'}`;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a repeat keyed DM in four requests: two read batches, the admission batch, the outcome reads', async () => {
    const { d1, trips, ws, alice } = d1Fixture();
    const first = await sendDm(d1, ws, alice, { to: 'bob', text: 'one' }, { idempotencyKey: 'warm-up' });
    trips.length = 0;

    const sent = await sendDm(d1, ws, alice, { to: 'bob', text: 'two' }, { idempotencyKey: 'repeat-key' });

    expect(sent.conversation_id).toBe(first.conversation_id);
    expect(sent._idempotency_replayed).toBeUndefined();
    const admission = trips.find((trip) => trip.startsWith('batch[insert:direct_dm_idempotency'));
    expect(admission).toBeDefined();
    expect(trips).toEqual([
      // Recipient, sender, idempotency claim, A2A request identity: one round trip.
      'batch[select:agents,select:agents,select:direct_dm_idempotency,select:a2a_egress]',
      // Steady conversation and A2A target: one round trip.
      'batch[select:dm_conversation_reservations,select:a2a_agents]',
      admission,
      // Post-commit outcome reads (already concurrent via Promise.all).
      'select:deliveries',
      'select:agents',
    ]);
    // Before batching this send was 8 sequential round trips (9 requests):
    // six single SELECTs, the admission batch and the concurrent outcome pair.
    const roundTrips = trips.filter((trip) => trip.startsWith('batch[')).length + 1;
    expect(roundTrips).toBe(4);
  });

  it('keeps the sequential reads on a transaction-capable handle', async () => {
    const { db, sqlite, ws, alice } = seed();
    await sendDm(db, ws, alice, { to: 'bob', text: 'one' }, { idempotencyKey: 'warm-up' });
    const statements: string[] = [];
    const original = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
      statements.push(tableOf(source));
      return original(source);
    }) as typeof sqlite.prepare);

    await sendDm(db, ws, alice, { to: 'bob', text: 'two' }, { idempotencyKey: 'repeat-key' });

    // The same six reads, one at a time and in today's order, before admission.
    expect(statements.slice(0, 6)).toEqual([
      'select:direct_dm_idempotency',
      'select:a2a_egress',
      'select:agents',
      'select:agents',
      'select:dm_conversation_reservations',
      'select:a2a_agents',
    ]);
  });

  it('reports a missing recipient with the same 404 and writes nothing', async () => {
    const { d1, trips, db, ws, alice } = d1Fixture();
    await expect(sendDm(d1, ws, alice, { to: 'nobody', text: 'hi' }, { idempotencyKey: 'k-missing' }))
      .rejects.toMatchObject({ code: 'agent_not_found', status: 404 });
    expect(trips).toEqual(['batch[select:agents,select:agents,select:direct_dm_idempotency,select:a2a_egress]']);
    expect(db.select().from(messages).all()).toHaveLength(0);
    expect(db.select().from(dmConversations).all()).toHaveLength(0);
  });

  it('sends and repeats a self-DM with no delivery', async () => {
    const { d1, trips, db, ws, alice } = d1Fixture();
    const first = await sendDm(d1, ws, alice, { to: '@self', text: 'note' }, { idempotencyKey: 'self-1' });
    trips.length = 0;
    const second = await sendDm(d1, ws, alice, { to: '@self', text: 'note 2' }, { idempotencyKey: 'self-2' });

    expect(second.conversation_id).toBe(first.conversation_id);
    expect(first.conversation_id).toBe(await expectedConversationId(ws, alice, alice));
    expect(second._delivery).toBeNull();
    expect(trips).toEqual([
      'batch[select:agents,select:agents,select:direct_dm_idempotency,select:a2a_egress]',
      'batch[select:dm_conversation_reservations,select:a2a_agents]',
      trips.find((trip) => trip.startsWith('batch[insert:direct_dm_idempotency')),
    ]);
    expect(db.select().from(messages).all()).toHaveLength(2);
  });

  it('replays the same key and body from the claim without another admission', async () => {
    const { d1, trips, db, ws, alice } = d1Fixture();
    const request = { to: 'bob', text: 'once' };
    const first = await sendDm(d1, ws, alice, request, { idempotencyKey: 'replay' });
    trips.length = 0;

    const replay = await sendDm(d1, ws, alice, request, { idempotencyKey: 'replay' });

    expect(replay.id).toBe(first.id);
    expect(replay._idempotency_replayed).toBe(true);
    expect(trips).toEqual(['batch[select:agents,select:agents,select:direct_dm_idempotency,select:a2a_egress]']);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(db.select().from(directDmIdempotency).all()).toHaveLength(1);
  });

  it('rejects the same key with a different body with the same 409', async () => {
    const { d1, db, ws, alice } = d1Fixture();
    await sendDm(d1, ws, alice, { to: 'bob', text: 'first body' }, { idempotencyKey: 'conflict' });

    await expect(sendDm(d1, ws, alice, { to: 'bob', text: 'second body' }, { idempotencyKey: 'conflict' }))
      .rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it('rejects a key reused for a missing recipient with the 409, not the 404', async () => {
    const { d1, ws, alice } = d1Fixture();
    await sendDm(d1, ws, alice, { to: 'bob', text: 'body' }, { idempotencyKey: 'order' });

    await expect(sendDm(d1, ws, alice, { to: 'nobody', text: 'body' }, { idempotencyKey: 'order' }))
      .rejects.toMatchObject({ code: 'idempotency_key_reused', status: 409 });
  });

  it('rejoins a departed participant through the write path after a steady miss', async () => {
    const { d1, trips, db, ws, alice, bob } = d1Fixture();
    const first = await sendDm(d1, ws, alice, { to: 'bob', text: 'hello' }, { idempotencyKey: 'rejoin-1' });
    db.update(dmParticipants)
      .set({ leftAt: new Date() })
      .where(and(eq(dmParticipants.conversationId, first.conversation_id), eq(dmParticipants.agentId, bob)))
      .run();
    trips.length = 0;

    const again = await sendDm(d1, ws, alice, { to: 'bob', text: 'again' }, { idempotencyKey: 'rejoin-2' });

    expect(again.conversation_id).toBe(first.conversation_id);
    expect(trips).toContain('insert:dm_participants');
    const departed = db.select().from(dmParticipants)
      .where(and(eq(dmParticipants.conversationId, first.conversation_id), isNotNull(dmParticipants.leftAt)))
      .all();
    expect(departed).toEqual([]);
  });

  it('drops the first read batch after deleting an expired claim and reads the rest sequentially', async () => {
    const { d1, db, trips, ws, alice } = d1Fixture();
    const first = await sendDm(d1, ws, alice, { to: 'bob', text: 'same' }, { idempotencyKey: 'expiring' });
    db.update(directDmIdempotency)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .run();
    trips.length = 0;

    const again = await sendDm(d1, ws, alice, { to: 'bob', text: 'same' }, { idempotencyKey: 'expiring' });
    const sendTrips = [...trips];

    expect(again._idempotency_replayed).toBeUndefined();
    expect(again.id).not.toBe(first.id);
    expect(db.select().from(messages).all()).toHaveLength(2);
    const admission = sendTrips.find((trip) => trip.startsWith('batch[insert:direct_dm_idempotency'));
    expect(admission).toBeDefined();
    expect(sendTrips).toEqual([
      'batch[select:agents,select:agents,select:direct_dm_idempotency,select:a2a_egress]',
      'delete:direct_dm_idempotency',
      // No row from the first batch is reused after the delete.
      'select:direct_dm_idempotency',
      'select:a2a_egress',
      'select:agents',
      'select:agents',
      'select:dm_conversation_reservations',
      'select:a2a_agents',
      admission,
      'select:deliveries',
      'select:agents',
    ]);
  });

  it('maps batched rows whose joined tables share column names like sequential reads', async () => {
    // agents.name / nodes.name and a2a_agents.status / agents.status share an
    // output column name. D1 batch() maps rows by name, so these reads must
    // give every output column its own name or the row shifts.
    const { d1, db, ws, alice, bob } = d1Fixture();
    db.insert(nodes).values([
      { id: 'node_a', workspaceId: ws, name: 'laptop-a', tokenHash: 'node_tok_a', machineId: 'mach-a' },
      { id: 'node_b', workspaceId: ws, name: 'laptop-b', tokenHash: 'node_tok_b', machineId: 'mach-b' },
    ]).run();
    db.update(agents).set({ locationNodeId: 'node_a' }).where(eq(agents.id, alice)).run();
    db.update(agents).set({ locationNodeId: 'node_b', status: 'online' }).where(eq(agents.id, bob)).run();
    db.insert(agents).values({ id: `${bob}_carol`, workspaceId: ws, name: 'carol', tokenHash: `${bob}_tok_c`, status: 'offline' }).run();
    db.insert(a2aAgents).values({
      id: 'a2a_carol',
      workspaceId: ws,
      relayAgentId: `${bob}_carol`,
      externalUrl: 'https://carol.example',
      status: 'paused',
      agentCard: { name: 'carol', url: 'https://carol.example', version: '1', skills: [{ id: 'chat', name: 'chat' }] },
    }).run();

    // The addressed recipient matches only through its node name.
    const sent = await sendDm(d1, ws, alice, { to: 'bob', text: 'hi' }, { idempotencyKey: 'addressed', address: 'bob@laptop-b' });
    const [stored] = db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, sent.id)).all();
    expect(JSON.stringify(stored?.metadata)).toContain('alice@laptop-a');

    const [batched] = await runIndependentReads(d1, [a2aAgentByRelayNameQuery(d1, ws, 'carol')] as const);
    const record = a2aAgentFromRows(batched);
    expect(record).toEqual(await getA2aAgentByRelayName(db, ws, 'carol'));
    expect(record).toMatchObject({ status: 'paused', relay_status: 'offline' });
  });
});
