import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { EffectiveMessageRetention, SessionMessagesResult } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { agents, channels, dmConversations, messageSessions, messages } from '../db/schema.js';
import type { AtomicWrite } from '../ports/database.js';
import { codedError } from '../lib/httpError.js';
import { displayAgentName, publicMessageMetadata } from './messageMetadata.js';
import {
  afterSnowflake,
  atOrAfterSnowflake,
  resolveEffectiveMessageRetention,
} from './retention.js';

type Db = ReturnType<typeof getDb>;

export const MAX_SESSION_REF_LENGTH = 255;
export const SESSION_MESSAGE_DEFAULT_LIMIT = 100;
export const SESSION_MESSAGE_MAX_LIMIT = 500;
export const SessionRefSchema = z
  .string()
  .min(1, 'session_ref must contain at least 1 character')
  .refine(
    (value) => Array.from(value).length <= MAX_SESSION_REF_LENGTH,
    `session_ref must contain at most ${MAX_SESSION_REF_LENGTH} characters`,
  );

export function sessionRefFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const parsed = SessionRefSchema.safeParse(metadata?.session_ref);
  return parsed.success ? parsed.data : null;
}

/** Resolve a trusted writer's replay key, rejecting a present invalid value. */
export function requireSessionRefFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (metadata?.session_ref === undefined) return null;
  const parsed = SessionRefSchema.safeParse(metadata.session_ref);
  if (!parsed.success) {
    throw codedError(
      parsed.error.issues[0]?.message ?? 'invalid session_ref',
      'invalid_session_ref',
      400,
    );
  }
  return parsed.data;
}

/** Build the payload-free durable ledger upsert for a stamped message. */
export function buildMessageSessionWrite(
  db: Db,
  workspaceId: string,
  sessionRef: string | null,
  messageAt: Date,
): AtomicWrite | null {
  if (!sessionRef) return null;
  return db
    .insert(messageSessions)
    .values({
      workspaceId,
      sessionRef,
      firstMessageAt: messageAt,
      lastMessageAt: messageAt,
    })
    .onConflictDoUpdate({
      target: [messageSessions.workspaceId, messageSessions.sessionRef],
      set: {
        firstMessageAt: sql`MIN(${messageSessions.firstMessageAt}, excluded.first_message_at)`,
        lastMessageAt: sql`MAX(${messageSessions.lastMessageAt}, excluded.last_message_at)`,
      },
    });
}

function unknownRetention(reason: 'boundary_unavailable' | 'workspace_unknown'): EffectiveMessageRetention {
  return {
    policy: 'unknown',
    message_ttl_days: null,
    retained_since: null,
    source: 'unknown',
    reason,
  };
}

function unknownResult(
  sessionRef: string,
  reason: 'boundary_unavailable' | 'workspace_unknown' | 'session_not_found' | 'query_failed',
  retention: EffectiveMessageRetention,
): SessionMessagesResult {
  return {
    session_ref: sessionRef,
    availability: 'unknown',
    reason,
    retention,
    session_started_at: null,
    session_last_message_at: null,
    messages: [],
    page: { next_cursor: null, has_more: false },
  };
}

export interface SessionMessageQueryOptions {
  limit?: number;
  after?: string;
  deploymentMessageTtlDays?: number | null;
  now?: Date;
}

/**
 * Resolve one session without scanning workspace history. Every live-message
 * read is constrained by `(workspace_id, session_ref, id)` and capped; the
 * ledger lookup is a composite-primary-key read.
 */
export async function getMessagesBySessionRef(
  db: Db,
  workspaceId: string,
  sessionRef: string,
  options: SessionMessageQueryOptions = {},
): Promise<SessionMessagesResult> {
  let retention: EffectiveMessageRetention;
  try {
    retention = await resolveEffectiveMessageRetention(
      db,
      workspaceId,
      options.deploymentMessageTtlDays,
      options.now,
    );
  } catch {
    return unknownResult(sessionRef, 'query_failed', unknownRetention('boundary_unavailable'));
  }

  if (retention.policy === 'unknown') {
    return unknownResult(sessionRef, retention.reason, retention);
  }

  try {
    const [session] = await db
      .select({
        firstMessageAt: messageSessions.firstMessageAt,
        lastMessageAt: messageSessions.lastMessageAt,
        startIsKnown: messageSessions.startIsKnown,
      })
      .from(messageSessions)
      .where(and(
        eq(messageSessions.workspaceId, workspaceId),
        eq(messageSessions.sessionRef, sessionRef),
      ));

    if (!session) {
      return unknownResult(sessionRef, 'session_not_found', retention);
    }

    let availability: 'retained' | 'partial' | 'aged_out' = 'retained';
    let retainedSince: Date | null = null;
    if (retention.policy === 'window') {
      retainedSince = new Date(retention.retained_since);
      if (session.lastMessageAt.getTime() < retainedSince.getTime()) {
        availability = 'aged_out';
      } else if (session.firstMessageAt.getTime() < retainedSince.getTime()) {
        availability = 'partial';
      }
    }
    if (availability !== 'aged_out' && !session.startIsKnown) {
      availability = 'partial';
    }

    const sessionTimes = {
      session_started_at: session.startIsKnown ? session.firstMessageAt.toISOString() : null,
      session_last_message_at: session.lastMessageAt.toISOString(),
    };
    if (availability === 'aged_out') {
      return {
        session_ref: sessionRef,
        availability,
        reason: 'outside_retention_window',
        retention,
        ...sessionTimes,
        messages: [],
        page: { next_cursor: null, has_more: false },
      };
    }

    const requestedLimit = Number.isFinite(options.limit)
      ? Math.trunc(options.limit!)
      : SESSION_MESSAGE_DEFAULT_LIMIT;
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      SESSION_MESSAGE_MAX_LIMIT,
    );
    const conditions = [
      eq(messages.workspaceId, workspaceId),
      eq(messages.sessionRef, sessionRef),
    ];
    if (options.after) conditions.push(afterSnowflake(messages.id, options.after));
    if (retainedSince) conditions.push(atOrAfterSnowflake(messages.id, retainedSince.getTime()));

    const rows = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        channelName: channels.name,
        conversationId: dmConversations.id,
        agentId: messages.agentId,
        agentName: agents.name,
        threadId: messages.threadId,
        body: messages.body,
        blocks: messages.blocks,
        metadata: messages.metadata,
        hasAttachments: messages.hasAttachments,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .leftJoin(channels, eq(messages.channelId, channels.id))
      .leftJoin(agents, eq(messages.agentId, agents.id))
      .leftJoin(dmConversations, eq(messages.channelId, dmConversations.channelId))
      .where(and(...conditions))
      .orderBy(asc(sql`length(${messages.id})`), asc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      session_ref: sessionRef,
      availability,
      ...(availability === 'partial' && !session.startIsKnown
        ? { reason: 'pre_migration_history_unknown' as const }
        : {}),
      retention,
      ...sessionTimes,
      messages: pageRows.map((row) => ({
        id: row.id,
        channel_id: row.channelId,
        channel_name: row.channelName ?? 'unknown',
        conversation_id: row.conversationId ?? null,
        agent_id: row.agentId,
        agent_name: displayAgentName(row.metadata, row.agentName),
        thread_id: row.threadId,
        text: row.body,
        blocks: (row.blocks as never[] | null) ?? null,
        metadata: publicMessageMetadata(row.metadata),
        has_attachments: row.hasAttachments,
        created_at: row.createdAt.toISOString(),
      })),
      page: {
        next_cursor: hasMore ? pageRows.at(-1)?.id ?? null : null,
        has_more: hasMore,
      },
    };
  } catch {
    return unknownResult(sessionRef, 'query_failed', retention);
  }
}
