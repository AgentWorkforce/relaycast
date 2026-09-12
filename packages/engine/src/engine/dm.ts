import { eq, and, sql, lt, lte, gt, isNull, inArray, desc } from 'drizzle-orm';
import type { DmMessage } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import {
  messages,
  channels,
  agents,
  dmConversations,
  dmConversationReservations,
  dmParticipants,
  messageAttachments,
  a2aEgress,
  a2aEgressContext,
  a2aInbound,
  a2aAgents,
  pendingEvents,
  messageLogs,
} from '../db/schema.js';
import { sha256Hex } from '../lib/crypto.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { generateId } from './snowflake.js';
import * as a2aEngine from './a2a.js';
import { buildMessageLogWrite } from './console.js';
import {
  buildDirectDeliveryWrite,
  fetchDirectDeliveryOutcomes,
  type DeliveryOutcomeRecords,
} from './deliveryWrites.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, type MailboxConfig } from './mailboxConfig.js';
import {
  type WorkspaceDeliveryPolicy,
} from './workspaceDeliveryPolicy.js';
import { dispatchA2aEgress } from './a2aEgress.js';
import { buildDmReceivedEventData } from './deliveryWire.js';
import { buildWorkspaceEventWrite } from './workspaceEvents.js';
import { transformForClient } from './wsTransform.js';
import { codedError } from '../lib/httpError.js';
import { buildMessageSessionWrite, requireSessionRefFromMetadata } from './sessionMessages.js';
import { fetchAttachmentsBatch, resolveSendAttachments, type AttachmentRow } from './attachments.js';
import { publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';
import { queryInChunks } from '../lib/queryChunks.js';

type Db = ReturnType<typeof getDb>;

interface SendDmOptions {
  skipA2aIntercept?: boolean;
  /** Stable request identity for resuming already admitted outbound A2A. */
  idempotencyKey?: string;
  /** Count an authenticated inbound peer in the same transaction as its DM. */
  receivedA2aAgentId?: string;
  /** Authenticated actor/scope/key identity, never a caller-selected recipient identity. */
  inboundIdentity?: { scope: string; key: string };
  /** Resolve only after durable accepted lookup (cached HTTP replay never calls sendDm). */
  resolveWorkspaceDeliveryPolicy?: () => Promise<WorkspaceDeliveryPolicy | undefined>;
  /** Fast paths only; durable events and delivery already committed before this hook. */
  afterAdmission?: (data: SendDmResult, event: { seq: number; payload: Record<string, unknown>; data: Record<string, unknown>; outboxId: string }) => void;
  mailbox?: MailboxConfig;
  /** Server-resolved workspace growth policy; absent => no workspace guard. */
  workspaceDeliveryPolicy?: WorkspaceDeliveryPolicy;
}

/**
 * Derivation only: this digest does not resolve or claim a conversation.
 * Callers must atomically reserve the derived id before using it.
 */
async function deriveDmPairKey(workspaceId: string, agentA: string, agentB: string): Promise<string> {
  const [first, second] = [agentA, agentB].sort();
  return (await sha256Hex(`${workspaceId}:${first}:${second}`)).slice(0, 24);
}

/**
 * Recognize a unique-constraint violation on `dm_conversation_reservations`
 * across every driver this engine actually runs on.
 *
 * THIS ENGINE HAS ALREADY REGRESSED THIS EXACT BUG CLASS ONCE. `engine/agent.ts`
 * gained `isUniqueConstraintError` in PR #193 after clean 409 handling silently
 * became an uncaught 500 against D1, because detection only matched
 * better-sqlite3's error shape. `engine/observerToken.ts` documents the same
 * trap. A first version of this handler matched `.code` and `.message` on the
 * top-level error only — which passes against better-sqlite3 in tests and would
 * have reproduced that regression in the hosted engine, where the driver differs
 * from the one the test suite exercises.
 *
 * Self-hosted runs on better-sqlite3: `.code` is `SQLITE_CONSTRAINT_UNIQUE` and
 * `.message` reads `UNIQUE constraint failed: dm_conversation_reservations...`.
 * The hosted engine runs Cloudflare D1 via `drizzle-orm/d1`, which prefixes
 * `D1_ERROR: ` and may re-wrap the driver error under `.cause` rather than
 * surfacing it at the top level. So the chain has to be walked.
 *
 * Two conditions must BOTH hold somewhere in the chain: the failure is a unique
 * violation, and it names this table. The table check is what stops an unrelated
 * constraint failure on this insert — a FK or NOT NULL on `workspace_id` — from
 * being laundered into a tidy 409 that says something untrue about participant
 * pairs. They are tracked independently across the walk because a wrapper may
 * carry the code while only the wrapped cause carries the message.
 *
 * The walk is iterative and records every object visited in a `WeakSet`,
 * breaking on any revisit rather than only a direct self-reference: a multi-step
 * cycle (`A -> B -> A`) would otherwise blow the stack and turn the check meant
 * to prevent a 500 into one itself. Same reasoning as `isObserverTokenNameConflict`.
 */
export function isPairReservationConflict(err: unknown): boolean {
  const visited = new WeakSet<object>();
  let current: unknown = err;
  let sawUniqueViolation = false;
  let namesReservationTable = false;

  while (current && typeof current === 'object') {
    if (visited.has(current)) break;
    visited.add(current);

    const candidate = current as { code?: string; message?: string; cause?: unknown };
    const message = candidate.message ?? '';
    const lowerMessage = message.toLowerCase();

    if (
      candidate.code === 'SQLITE_CONSTRAINT_UNIQUE'
      || lowerMessage.includes('unique constraint failed')
      || (candidate.code === 'SQLITE_CONSTRAINT' && lowerMessage.includes('unique'))
    ) {
      sawUniqueViolation = true;
    }
    if (lowerMessage.includes('dm_conversation_reservations')) {
      namesReservationTable = true;
    }

    current = candidate.cause;
  }

  return sawUniqueViolation && namesReservationTable;
}

/**
 * Atomically resolve or reserve a deterministic 1:1 DM id for one exact tuple.
 *
 * The primary-key conflict and conditional no-op update are one SQL statement.
 * An identical tuple returns the existing reservation; a digest collision makes
 * the conflict predicate false, returns no row, and fails closed.
 *
 * TWO DISTINCT COLLISIONS, and both must fail closed with the same coded 409:
 *
 *   1. Same conversation_id, different pair. Caught by the PRIMARY KEY conflict
 *      target: the conditional update predicate is false, no row is returned.
 *
 *   2. Same pair, different conversation_id. This violates the pair_unique
 *      index, which is NOT the conflict target - SQLite only accepts one - so
 *      the statement raises SQLITE_CONSTRAINT_UNIQUE. Raised in review of PR
 *      #303 and reachable in practice: migration 0033 backfills whatever `dc.id`
 *      a legacy 1:1 already had, without requiring it to equal the current
 *      derivation, so the pair can be reserved under an id the next send will
 *      not re-derive. Left unhandled that surfaced as a 500.
 *
 * Failing closed is not sufficient on its own. It has to fail closed with the
 * documented code, or a caller cannot tell a refused collision from an engine
 * fault - which is the same distinction the rest of this seam exists to make.
 */
async function resolveOrReserveConversation(
  db: Db,
  conversationId: string,
  workspaceId: string,
  sortedPair: readonly [string, string],
): Promise<void> {
  const [participantOneId, participantTwoId] = sortedPair;

  let reservation: { conversationId: string } | undefined;
  try {
    [reservation] = await db
      .insert(dmConversationReservations)
      .values({
        conversationId,
        workspaceId,
        participantOneId,
        participantTwoId,
      })
      .onConflictDoUpdate({
        target: dmConversationReservations.conversationId,
        set: { conversationId: sql`excluded.conversation_id` },
        setWhere: and(
          eq(dmConversationReservations.workspaceId, workspaceId),
          eq(dmConversationReservations.participantOneId, participantOneId),
          eq(dmConversationReservations.participantTwoId, participantTwoId),
        ),
      })
      .returning({ conversationId: dmConversationReservations.conversationId });
  } catch (err) {
    // Collision (2) above.
    if (!isPairReservationConflict(err)) throw err;

    throw codedError(
      'DM participant pair is already reserved under a different conversation identifier',
      'dm_conversation_id_collision',
      409,
    );
  }

  if (!reservation) {
    throw codedError(
      'DM conversation identifier is already reserved for a different participant pair',
      'dm_conversation_id_collision',
      409,
    );
  }
}

async function resolveConversation(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  toAgentId: string,
) {
  const sortedPair = [fromAgentId, toAgentId].sort() as [string, string];
  const pairKey = await deriveDmPairKey(workspaceId, sortedPair[0], sortedPair[1]);
  const conversationId = `dm_${pairKey}`;
  const channelId = `dmch_${pairKey}`;

  // This is the mandatory resolution seam. It must happen before any metadata
  // creation so exactly one tuple can win a digest collision.
  await resolveOrReserveConversation(db, conversationId, workspaceId, sortedPair);

  await db.insert(channels).values({
    id: channelId,
    workspaceId,
    name: `dm-${pairKey}`,
    channelType: 1,
  }).onConflictDoNothing();

  await db.insert(dmConversations).values({
    id: conversationId,
    workspaceId,
    channelId,
    dmType: '1:1',
  }).onConflictDoNothing();

  // A deterministic 1:1 is a durable relationship. Re-resolution restores a
  // stale departure marker instead of letting roster state disagree with it.
  const rejoin = {
    target: [dmParticipants.conversationId, dmParticipants.agentId],
    set: { leftAt: null },
  };

  await db.insert(dmParticipants).values({
    conversationId,
    agentId: fromAgentId,
  }).onConflictDoUpdate(rejoin);
  await db.insert(dmParticipants).values({
    conversationId,
    agentId: toAgentId,
  }).onConflictDoUpdate(rejoin);

  const [conv] = await db
    .select({ id: dmConversations.id, channelId: dmConversations.channelId })
    .from(dmConversations)
    .where(
      and(
        eq(dmConversations.id, conversationId),
        eq(dmConversations.workspaceId, workspaceId),
      ),
    );

  if (!conv) {
    throw codedError('Conversation not found', 'not_found', 404);
  }

  return conv;
}

/**
 * Build the message + attachment-junction inserts for a DM without executing
 * them, so the send path can run them inside one atomic unit. The message
 * insert is always first and carries `.returning()`.
 */
function buildDmMessageWrites(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  channelId: string,
  data: {
    text: string;
    attachments?: string[];
    mode?: 'wait' | 'steer';
    data?: Record<string, unknown> | null;
  },
  attachments: AttachmentRow[],
  messageId: string,
  createdAt = new Date(),
): AtomicWrite[] {
  const hasAttachments = attachments.length > 0;
  const metadata = {
    // Keep the server-owned delivery mode after caller metadata so a
    // federated peer cannot override how the local runtime is injected.
    ...sanitizeUserMessageMetadata(data.data),
    injection_mode: data.mode ?? 'wait',
  };
  const sessionRef = requireSessionRefFromMetadata(metadata);
  const writes: AtomicWrite[] = [
    db
      .insert(messages)
      .values({
        id: messageId,
        workspaceId,
        channelId,
        agentId: fromAgentId,
        body: data.text,
        hasAttachments,
        metadata,
        sessionRef,
        createdAt,
      })
      .returning(),
  ];

  const sessionWrite = buildMessageSessionWrite(
    db,
    workspaceId,
    sessionRef,
    createdAt,
  );
  if (sessionWrite) writes.push(sessionWrite);

  if (attachments.length > 0) {
    const attachmentValues = attachments.map((attachment, idx) => ({
      messageId,
      fileId: attachment.file_id,
      position: idx,
    }));
    writes.push(db.insert(messageAttachments).values(attachmentValues));
  }

  return writes;
}

function buildDmResult(
  message: Pick<typeof messages.$inferSelect, 'id' | 'agentId' | 'body' | 'metadata' | 'createdAt'>,
  conv: { id: string }, fromAgent: { name: string }, data: { to: string; mode?: 'wait' | 'steer' },
  attachments: AttachmentRow[],
) {
  const injectionMode = data.mode ?? 'wait';
  return {
    // Canonical converged shape (new)
    conversation_id: conv.id,
    message: {
      id: message.id,
      agent_id: message.agentId,
      agent_name: fromAgent.name,
      text: message.body,
      injection_mode: injectionMode,
      attachments,
      metadata: publicMessageMetadata(message.metadata),
    },
    created_at: message.createdAt.toISOString(),

    // Legacy compatibility fields (scheduled for removal in next major).
    id: message.id,
    from_agent_id: message.agentId,
    to: data.to,
    text: message.body,
    injection_mode: injectionMode,
    attachments,
    metadata: publicMessageMetadata(message.metadata),
  };
}

export type AcceptedDmResult = ReturnType<typeof buildDmResult>;
export type SendDmResult = AcceptedDmResult & {
  _delivery: DeliveryOutcomeRecords['deliveries'][number] | null;
  _delivery_rejections: DeliveryOutcomeRecords['rejections'];
  _notifications_durable?: boolean;
};

export async function sendDm(
  db: Db,
  workspaceId: string,
  fromAgentId: string,
  data: {
    to: string;
    text: string;
    attachments?: string[];
    mode?: 'wait' | 'steer';
    data?: Record<string, unknown> | null;
  },
  options: SendDmOptions = {},
): Promise<SendDmResult> {
  const startedAtMs = Date.now();
  // Resolve durable request identity before mutable recipient/attachment metadata.
  // A removed/recreated target must never turn an accepted retry into a new send.
  const requestEgressId = !options.skipA2aIntercept && options.idempotencyKey
    ? `a2ae_${await sha256Hex(JSON.stringify([workspaceId, fromAgentId, options.idempotencyKey]))}`
    : null;
  const [accepted] = requestEgressId ? await db.select().from(a2aEgress).where(eq(a2aEgress.id, requestEgressId)) : [];
  if (accepted) {
    if (accepted.fingerprint !== await sha256Hex(JSON.stringify(data))) {
      throw codedError('Idempotency-Key was reused with a different request payload', 'idempotency_key_reused', 409);
    }
    await dispatchA2aEgress(db, accepted.id);
    let [context] = await db.select().from(a2aEgressContext).where(eq(a2aEgressContext.id, accepted.id));
    if (!context) {
      // Upgrade compatibility for admissions predating 0058: recover only from
      // the original retained message/log, never recipient-name resolution or
      // conversation creation. New admissions always carry the atomic snapshot.
      const [source] = await db.select({ message: messages, conversationId: messageLogs.conversationId, senderName: agents.name })
        .from(messages)
        .leftJoin(messageLogs, eq(messageLogs.messageId, messages.id))
        .leftJoin(agents, eq(agents.id, messages.agentId))
        .where(and(eq(messages.id, accepted.messageId), eq(messages.workspaceId, workspaceId)));
      if (!source) throw codedError('Accepted A2A message is no longer retained', 'a2a_message_not_retained', 410);
      const retainedAttachments = await fetchAttachmentsBatch(db, workspaceId, [source.message.id]);
      const response = buildDmResult(source.message, {
        id: source.conversationId ?? source.message.channelId.replace(/^dmch_/, 'dm_'),
      }, { name: source.senderName ?? fromAgentId }, data, retainedAttachments.get(source.message.id) ?? []);
      await db.insert(a2aEgressContext).values({ id: accepted.id, messageId: accepted.messageId, response }).onConflictDoNothing();
      [context] = await db.select().from(a2aEgressContext).where(eq(a2aEgressContext.id, accepted.id));
    }
    return { ...context.response, _delivery: null, _delivery_rejections: [], _notifications_durable: true };
  }

  const inboundId = options.inboundIdentity
    ? `a2ai_${await sha256Hex(JSON.stringify([workspaceId, fromAgentId, options.inboundIdentity.scope, options.inboundIdentity.key]))}`
    : null;
  const inboundFingerprint = inboundId ? await sha256Hex(JSON.stringify(data)) : '';
  if (inboundId) {
    const [retained] = await db.select().from(a2aInbound).where(eq(a2aInbound.id, inboundId));
    if (retained && retained.createdAt.getTime() + 86_400_000 > Date.now()) {
      if (retained.fingerprint !== inboundFingerprint) throw codedError('Idempotency-Key was reused with a different request payload', 'idempotency_key_reused', 409);
      if (!retained.messageId || !retained.response) throw codedError('Accepted A2A message is no longer retained', 'a2a_message_not_retained', 410);
      return { ...retained.response, _delivery: null, _delivery_rejections: [], _notifications_durable: true };
    }
    if (retained) await db.delete(a2aInbound).where(and(eq(a2aInbound.id, inboundId), lte(a2aInbound.createdAt, new Date(Date.now() - 86_400_000))));
  }
  const workspacePolicy = options.resolveWorkspaceDeliveryPolicy
    ? await options.resolveWorkspaceDeliveryPolicy() : options.workspaceDeliveryPolicy;

  const [toAgent] = data.to === '@self'
    ? await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, fromAgentId)))
    : await db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.to)));

  if (!toAgent) {
    throw codedError(`Agent "${data.to}" not found`, 'agent_not_found', 404);
  }

  const [fromAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, fromAgentId)));

  if (!fromAgent?.name) {
    throw codedError('Sender agent not found', 'internal_error', 500);
  }

  // Resolve attachments first so invalid attachments fail before any DM
  // metadata (channel/conversation/participant rows) is created.
  const attachments = await resolveSendAttachments(db, workspaceId, data.attachments);
  const conv = await resolveConversation(db, workspaceId, fromAgentId, toAgent.id);
  const a2aTarget = options.skipA2aIntercept
    ? null
    : await a2aEngine.getA2aAgentByRelayName(db, workspaceId, toAgent.name);

  const egressId = a2aTarget
    ? `a2ae_${await sha256Hex(JSON.stringify([workspaceId, fromAgentId, options.idempotencyKey ?? generateId()]))}`
    : null;
  const fingerprint = egressId ? await sha256Hex(JSON.stringify(data)) : '';
  const messageId = generateId();
  // Match SQLite timestamp precision so live, retained response and delivery replay agree.
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
  };

  let egressPayload: ReturnType<typeof a2aEngine.translateRelayToA2a> | undefined;
  if (a2aTarget) {
    const payload = a2aEngine.translateRelayToA2a({
      id: messageId,
      agent_id: fromAgentId,
      agent_name: fromAgent.name,
      text: data.text,
      created_at: createdAt.toISOString(),
      thread_id: conv.id,
      attachments,
      metadata: sanitizeUserMessageMetadata(data.data),
    });

    payload.params = {
      ...payload.params,
      target_agent:
        typeof a2aTarget.relay_metadata?.a2a_target_agent === 'string'
          ? a2aTarget.relay_metadata.a2a_target_agent
          : toAgent.name,
      metadata: {
        target_agent: fromAgent.name,
        relay_conversation_id: conv.id,
      },
    };

    egressPayload = payload;
  }

  const deliveryId = toAgent.id !== fromAgentId ? `del_${generateId()}` : null;

  const publicResult = buildDmResult({
    id: messageId, agentId: fromAgentId, body: data.text, createdAt,
    metadata: { ...sanitizeUserMessageMetadata(data.data), injection_mode: data.mode ?? 'wait' },
  }, conv, fromAgent, data, attachments);
  const eventData = buildDmReceivedEventData(publicResult, { fromName: fromAgent.name });
  const workspacePayload = transformForClient({
    type: 'dm.received', workspace_id: workspaceId, data: eventData, timestamp: createdAt.toISOString(),
  });
  // The outbox, observer cursor log, response context and delivery share admission.
  // None can escape a capacity rollback, or depend on external transport success.
  const persist = () => runAtomicWrites(db, (writeDb) => {
    const writes = buildDmMessageWrites(writeDb, workspaceId, fromAgentId, conv.channelId, data, attachments, messageId, createdAt);

    if (egressId && a2aTarget && egressPayload) {
      // First statement owns the request identity; a competing attempt rolls
      // back before it can consume capacity or invoke the external transport.
      writes.unshift(writeDb.insert(a2aEgress).values({
        id: egressId, workspaceId, messageId, targetId: a2aTarget.id,
        externalUrl: a2aTarget.external_url, fingerprint, payload: egressPayload,
      }));
    }
    if (options.receivedA2aAgentId) {
      writes.push(writeDb.update(a2aAgents).set({ messagesRecv: sql`${a2aAgents.messagesRecv} + 1`, updatedAt: createdAt })
        .where(and(eq(a2aAgents.id, options.receivedA2aAgentId), eq(a2aAgents.workspaceId, workspaceId))));
    }
    if (deliveryId) {
      writes.push(
        buildDirectDeliveryWrite(writeDb, {
          deliveryId,
          workspaceId,
          messageId,
          agentId: toAgent.id,
          mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
          reason: 'dm',
          ttlMs: mailbox.ttlMs,
          depthCap: mailbox.depthCap,
          workspacePolicy,
        }),
      );
    }

    writes.push(
      buildMessageLogWrite(writeDb, {
        workspaceId,
        messageId,
        channelId: conv.channelId,
        agentId: fromAgentId,
        conversationId: conv.id,
        deliveryKind: 'dm',
        body: data.text,
        contentType: 'text/plain',
        metadata: {
          target_agent: toAgent.name,
          injection_mode: data.mode ?? 'wait',
          ...(a2aTarget ? { a2a_target_url: a2aTarget.external_url } : {}),
        },
        attachmentCount: attachments.length,
        mentionCount: 0,
        latencyMs: Date.now() - startedAtMs,
      }),
    );

    if (inboundId) writes.push(writeDb.insert(a2aInbound).values({ id: inboundId, workspaceId, messageId, fingerprint: inboundFingerprint, response: publicResult }));
    if (egressId) writes.push(writeDb.insert(a2aEgressContext).values({ id: egressId, messageId, response: publicResult }));
    if (egressId || options.receivedA2aAgentId || inboundId) {
      writes.push(
        writeDb.insert(pendingEvents).values({ id: messageId, workspaceId, eventType: 'dm.received', payload: eventData }),
        buildWorkspaceEventWrite(writeDb, workspaceId, { type: 'dm.received', payload: workspacePayload }),
      );
    }
    return writes;
  }, { requireAtomic: Boolean(workspacePolicy || a2aTarget || options.receivedA2aAgentId || inboundId) });
  let admittedEventSeq: number | undefined;
  try {
    const results = await persist();
    if (egressId || options.receivedA2aAgentId || inboundId) admittedEventSeq = (results[results.length - 1] as { seq: number }[])[0].seq;
  } catch (error) {
    if (inboundId) {
      const [winner] = await db.select().from(a2aInbound).where(eq(a2aInbound.id, inboundId));
      if (winner) {
        if (winner.fingerprint !== inboundFingerprint) throw codedError('Idempotency-Key was reused with a different request payload', 'idempotency_key_reused', 409);
        return sendDm(db, workspaceId, fromAgentId, data, options);
      }
    }
    // Inspect the actual committed winner after the losing atomic batch rolls back.
    const [winner] = egressId ? await db.select().from(a2aEgress).where(eq(a2aEgress.id, egressId)) : [];
    if (!winner) throw error;
    if (winner.fingerprint !== fingerprint) {
      throw codedError('Idempotency-Key was reused with a different request payload', 'idempotency_key_reused', 409);
    }
    return sendDm(db, workspaceId, fromAgentId, data, options);
  }
  const deliveryOutcomes: DeliveryOutcomeRecords = deliveryId
    ? await fetchDirectDeliveryOutcomes(db, { messageId, recipientAgentId: toAgent.id })
    : { deliveries: [], rejections: [] };
  const dmDelivery = deliveryOutcomes.deliveries[0] ?? null;

  const result: SendDmResult = {
    ...publicResult,
    _delivery: dmDelivery,
    _delivery_rejections: deliveryOutcomes.rejections,
    ...((egressId || options.receivedA2aAgentId || inboundId) ? { _notifications_durable: true } : {}),
  };
  if (egressId || options.receivedA2aAgentId || inboundId) {
    // Local fast paths run independently of transport. A crash here still leaves
    // the webhook outbox, workspace cursor log and queued delivery recoverable.
    options.afterAdmission?.(result, { seq: admittedEventSeq!, payload: workspacePayload, data: eventData, outboxId: messageId });
  }
  if (egressId) await dispatchA2aEgress(db, egressId);
  return result;
}

export async function listConversations(
  db: Db,
  workspaceId: string,
  agentId: string,
  opts: { limit?: number } = {},
) {
  // Conversation ids are deterministic hashes, while created_at only has
  // second precision. SQLite's insertion rowid supplies the chronological
  // tiebreaker for conversations created within the same second.
  const insertionOrder = sql<number>`${dmConversations}.rowid`;
  const conversationQuery = db
    .select({
      id: dmConversations.id,
      dmType: dmConversations.dmType,
      name: dmConversations.name,
      channelId: dmConversations.channelId,
      createdAt: dmConversations.createdAt,
    })
    .from(dmConversations)
    .innerJoin(dmParticipants, eq(dmParticipants.conversationId, dmConversations.id))
    .where(
      and(
        eq(dmConversations.workspaceId, workspaceId),
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
      ),
    )
    .orderBy(
      desc(dmConversations.createdAt),
      desc(insertionOrder),
    );
  const conversationRows = opts.limit === undefined
    ? await conversationQuery
    : await conversationQuery.limit(opts.limit);

  if (conversationRows.length === 0) {
    return [];
  }

  const conversationIds = conversationRows.map((row) => row.id);
  const channelIds = conversationRows.map((row) => row.channelId);

  const participantRows = await queryInChunks(conversationIds, (ids) => db
    .select({
      conversationId: dmParticipants.conversationId,
      agentId: dmParticipants.agentId,
      agentName: agents.name,
    })
    .from(dmParticipants)
    .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
    .where(inArray(dmParticipants.conversationId, ids)));

  const counts = await queryInChunks(channelIds, (ids) => db
    .select({ channelId: messages.channelId, count: sql<number>`count(*)` })
    .from(messages)
    .where(inArray(messages.channelId, ids))
    .groupBy(messages.channelId));

  const latestMessageIds = await queryInChunks(channelIds, (ids) => db
    .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
    .from(messages)
    .where(inArray(messages.channelId, ids))
    .groupBy(messages.channelId));

  const lastIds = latestMessageIds.map((row) => row.lastId).filter(Boolean);
  const lastMessages = await queryInChunks(lastIds, (ids) => db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      agentId: messages.agentId,
      body: messages.body,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(inArray(messages.id, ids)));

  const participantsByConversation = new Map<string, Array<{ agent_id: string; agent_name: string }>>();
  for (const row of participantRows) {
    const list = participantsByConversation.get(row.conversationId) || [];
    list.push({ agent_id: row.agentId, agent_name: row.agentName });
    participantsByConversation.set(row.conversationId, list);
  }

  const countByChannel = new Map<string, number>(
    counts.map((row) => [row.channelId, row.count]),
  );

  const lastMessageByChannel = new Map<string, typeof lastMessages[number]>(
    lastMessages.map((row) => [row.channelId, row]),
  );

  return conversationRows.map((conv) => {
    const lastMessage = lastMessageByChannel.get(conv.channelId);
    return {
      id: conv.id,
      type: conv.dmType,
      name: conv.name,
      participants: participantsByConversation.get(conv.id) || [],
      last_message: lastMessage
        ? {
          id: lastMessage.id,
          text: lastMessage.body,
          agent_id: lastMessage.agentId,
          created_at: lastMessage.createdAt.toISOString(),
        }
        : null,
      unread_count: countByChannel.get(conv.channelId) ?? 0,
      created_at: conv.createdAt.toISOString(),
    };
  });
}

export async function getDmMessages(
  db: Db,
  workspaceId: string,
  conversationId: string,
  agentId: string,
  opts: { limit?: number; before?: string; after?: string } = {},
): Promise<DmMessage[]> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 100);

  // Verify agent is a participant
  const [participant] = await db
    .select()
    .from(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversationId, conversationId),
        eq(dmParticipants.agentId, agentId),
        isNull(dmParticipants.leftAt),
      ),
    );

  if (!participant) {
    throw codedError('Not a participant in this conversation', 'forbidden', 403);
  }

  // Get the conversation to find the channel
  const [conv] = await db
    .select()
    .from(dmConversations)
    .where(
      and(
        eq(dmConversations.id, conversationId),
        eq(dmConversations.workspaceId, workspaceId),
      ),
    );

  if (!conv) {
    throw codedError('Conversation not found', 'not_found', 404);
  }

  const conditions = [eq(messages.channelId, conv.channelId)];

  // Compare/sort on the indexed text PK directly: snowflake ids are fixed-width
  // (19 digits) so lexical order matches numeric order, and this keeps the PK
  // index usable for range scans (a CAST would force a full scan).
  if (opts.before) {
    conditions.push(lt(messages.id, opts.before));
  }
  if (opts.after) {
    conditions.push(gt(messages.id, opts.after));
  }

  const rows = await db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      agentName: agents.name,
      body: messages.body,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(agents, eq(messages.agentId, agents.id))
    .where(and(...conditions))
    .orderBy(sql`${messages.id} DESC`)
    .limit(limit);

  const attachmentMap = await fetchAttachmentsBatch(db, workspaceId, rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    agent_id: r.agentId,
    agent_name: r.agentName,
    text: r.body,
    injection_mode: r.metadata?.injection_mode as 'wait' | 'steer' | undefined,
    metadata: publicMessageMetadata(r.metadata),
    attachments: attachmentMap.get(r.id) || [],
    created_at: r.createdAt.toISOString(),
  }));
}
