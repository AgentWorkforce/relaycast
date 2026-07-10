import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { triggers } from '../db/schema.js';
import { codedError } from '../lib/httpError.js';
import type { NodeConnectionRegistry } from '../ports/realtime.js';
import { generateId } from './snowflake.js';
import { invokeAction } from './action.js';

type Db = ReturnType<typeof getDb>;
type TriggerRow = typeof triggers.$inferSelect;

const TRIGGER_RATE_LIMIT_MS = 5_000;

export interface TriggerMessageInput {
  id: string;
  channel_id: string;
  channel_name: string;
  agent_id: string;
  agent_name?: string;
  text: string;
  mentions?: string[];
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

function normalizeChannelName(name: string | null): string | null {
  if (!name) return null;
  return name.startsWith('#') ? name.slice(1) : name;
}

function validatePattern(pattern?: string | null) {
  if (!pattern) return;
  try {
    new RegExp(pattern);
  } catch {
    throw codedError('pattern must be a valid regular expression', 'invalid_pattern', 400);
  }
}

function publicTrigger(row: TriggerRow) {
  return {
    id: row.id,
    channel: row.channel,
    pattern: row.pattern,
    mention: row.mention,
    action_name: row.actionName,
    enabled: row.enabled,
    last_triggered_at: row.lastTriggeredAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

function isActionGeneratedMessage(message: TriggerMessageInput): boolean {
  const metadata = message.metadata ?? {};
  return (
    metadata.action_generated === true ||
    metadata.relaycast_action === true ||
    metadata.source === 'action' ||
    typeof metadata.action_invocation_id === 'string' ||
    typeof metadata.trigger_id === 'string'
  );
}

function matchesTrigger(row: TriggerRow, message: TriggerMessageInput): boolean {
  const triggerChannel = normalizeChannelName(row.channel);
  if (triggerChannel && triggerChannel !== message.channel_name) return false;
  if (row.mention && (!message.mentions || message.mentions.length === 0)) return false;
  if (row.pattern) {
    try {
      if (!new RegExp(row.pattern).test(message.text)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function rateLimited(row: TriggerRow, now: number): boolean {
  return !!row.lastTriggeredAt && now - row.lastTriggeredAt.getTime() < TRIGGER_RATE_LIMIT_MS;
}

export async function createTrigger(
  db: Db,
  workspaceId: string,
  data: {
    channel?: string | null;
    pattern?: string | null;
    mention?: boolean | null;
    action_name: string;
    enabled?: boolean;
  },
) {
  validatePattern(data.pattern);
  const [created] = await db
    .insert(triggers)
    .values({
      id: `trg_${generateId()}`,
      workspaceId,
      channel: normalizeChannelName(data.channel ?? null),
      pattern: data.pattern ?? null,
      mention: data.mention ?? null,
      actionName: data.action_name,
      enabled: data.enabled ?? true,
    })
    .returning();
  return publicTrigger(created);
}

export async function listTriggers(db: Db, workspaceId: string) {
  const rows = await db.select().from(triggers).where(eq(triggers.workspaceId, workspaceId));
  return rows.map(publicTrigger);
}

export async function getTrigger(db: Db, workspaceId: string, id: string) {
  const [row] = await db.select().from(triggers).where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)));
  return row ? publicTrigger(row) : null;
}

export async function updateTrigger(
  db: Db,
  workspaceId: string,
  id: string,
  data: {
    channel?: string | null;
    pattern?: string | null;
    mention?: boolean | null;
    action_name?: string;
    enabled?: boolean;
  },
) {
  validatePattern(data.pattern);
  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if ('channel' in data) setClause.channel = normalizeChannelName(data.channel ?? null);
  if ('pattern' in data) setClause.pattern = data.pattern ?? null;
  if ('mention' in data) setClause.mention = data.mention ?? null;
  if (data.action_name !== undefined) setClause.actionName = data.action_name;
  if (data.enabled !== undefined) setClause.enabled = data.enabled;

  const [updated] = await db
    .update(triggers)
    .set(setClause)
    .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)))
    .returning();
  return updated ? publicTrigger(updated) : null;
}

export async function deleteTrigger(db: Db, workspaceId: string, id: string) {
  const deleted = await db
    .delete(triggers)
    .where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.id, id)))
    .returning({ id: triggers.id });
  return deleted.length > 0;
}

export async function fireMessageTriggers(args: {
  db: Db;
  nodeConnections: NodeConnectionRegistry;
  workspaceId: string;
  message: TriggerMessageInput;
}) {
  if (isActionGeneratedMessage(args.message)) return [];
  const rows = await args.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.workspaceId, args.workspaceId), eq(triggers.enabled, true)));

  const now = Date.now();
  const cutoff = new Date(now - TRIGGER_RATE_LIMIT_MS);
  const invoked: string[] = [];

  for (const row of rows) {
    if (!matchesTrigger(row, args.message) || rateLimited(row, now)) continue;

    const [claimed] = await args.db
      .update(triggers)
      .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(triggers.workspaceId, args.workspaceId),
        eq(triggers.id, row.id),
        eq(triggers.enabled, true),
        or(
          isNull(triggers.lastTriggeredAt),
          lt(triggers.lastTriggeredAt, cutoff),
        ),
      ))
      .returning({ id: triggers.id });

    if (!claimed) continue;

    try {
      await invokeAction(args.db, args.workspaceId, row.actionName, {
        caller_id: args.message.agent_id,
        caller_name: args.message.agent_name,
        input: {
          trigger_id: row.id,
          message: args.message,
        },
        // A trigger binds to an action name without a node, so it must reach
        // node-scoped (fleet-provider) actions too, not only agent-hosted and
        // workspace-global ones.
      }, { nodeConnections: args.nodeConnections, includeNodeScoped: true });
      invoked.push(row.id);
    } catch {
      // Trigger delivery is best-effort; message posting has already succeeded.
    }
  }

  return invoked;
}
