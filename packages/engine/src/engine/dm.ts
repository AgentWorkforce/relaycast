import { eq, and, sql, lt, gt, isNull, inArray } from 'drizzle-orm';
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
import { codedError } from '../lib/httpError.js';
import { fetchAttachmentsBatch, resolveSendAttachments, type AttachmentRow } from './attachments.js';
import { publicMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';

type Db = ReturnType<typeof getDb>;

interface SendDmOptions {
  skipA2aIntercept?: boolean;
  mailbox?: MailboxConfig;
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
): AtomicWrite[] {
  const hasAttachments = attachments.length > 0;
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
        metadata: {
          // Keep the server-owned delivery mode after caller metadata so a
          // federated peer cannot override how the local runtime is injected.
          ...sanitizeUserMessageMetadata(data.data),
          injection_mode: data.mode ?? 'wait',
        },
      })
      .returning(),
  ];

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
) {
  const startedAtMs = Date.now();
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

  const messageId = generateId();
  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
  };

  if (a2aTarget) {
    const payload = a2aEngine.translateRelayToA2a({
      id: messageId,
      agent_id: fromAgentId,
      agent_name: fromAgent.name,
      text: data.text,
      created_at: new Date().toISOString(),
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

    await a2aEngine.sendToExternalAgent(a2aTarget.external_url, payload, {
      scheme: a2aTarget.auth_scheme,
      credential: a2aTarget.auth_credential,
    });
    await a2aEngine.incrementA2aMessagesSent(db, a2aTarget.id);
  }

  const deliveryId = toAgent.id !== fromAgentId ? `del_${generateId()}` : null;

  // Durable writes (message + attachments + delivery + message_log) run as one
  // atomic unit when the adapter supports it; fanout stays in routes.
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes = buildDmMessageWrites(writeDb, workspaceId, fromAgentId, conv.channelId, data, attachments, messageId);

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

    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];
  const deliveryOutcomes: DeliveryOutcomeRecords = deliveryId
    ? await fetchDirectDeliveryOutcomes(db, { messageId, recipientAgentId: toAgent.id })
    : { deliveries: [], rejections: [] };
  const dmDelivery = deliveryOutcomes.deliveries[0] ?? null;

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

    // Internal: delivery record for the recipient — stripped by route before response
    _delivery: dmDelivery,
    _delivery_rejections: deliveryOutcomes.rejections,
  };
}

export async function listConversations(db: Db, workspaceId: string, agentId: string) {
  const conversationRows = await db
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
    );

  if (conversationRows.length === 0) {
    return [];
  }

  const conversationIds = conversationRows.map((row) => row.id);
  const channelIds = conversationRows.map((row) => row.channelId);

  const participantRows = await db
    .select({
      conversationId: dmParticipants.conversationId,
      agentId: dmParticipants.agentId,
      agentName: agents.name,
    })
    .from(dmParticipants)
    .innerJoin(agents, eq(dmParticipants.agentId, agents.id))
    .where(inArray(dmParticipants.conversationId, conversationIds));

  const counts = await db
    .select({ channelId: messages.channelId, count: sql<number>`count(*)` })
    .from(messages)
    .where(inArray(messages.channelId, channelIds))
    .groupBy(messages.channelId);

  const latestMessageIds = await db
    .select({ channelId: messages.channelId, lastId: sql<string>`max(${messages.id})` })
    .from(messages)
    .where(inArray(messages.channelId, channelIds))
    .groupBy(messages.channelId);

  const lastIds = latestMessageIds.map((row) => row.lastId).filter(Boolean);
  const lastMessages = lastIds.length > 0
    ? await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        agentId: messages.agentId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.id, lastIds))
    : [];

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
