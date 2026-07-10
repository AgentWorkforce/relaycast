import type { CloudflareBindings } from '../env.js';
import { sendToNode } from '../durable-objects/node.js';
import { generateFleetId } from './crypto.js';
import { toFleetJson } from './wire.js';

const TRIGGER_RATE_LIMIT_MS = 5_000;

type TriggerRow = {
  id: string;
  channel: string | null;
  pattern: string | null;
  mention: number | null;
  action_name: string;
  last_triggered_at: number | null;
};

type ActionNodeRow = {
  action_id: string;
  action_name: string;
  handler_node_id: string;
  node_status: string;
  handlers_live: number;
  last_heartbeat_at: number | null;
};

type TriggerMessage = {
  id: string;
  channel_id: string;
  channel_name: string;
  agent_id: string;
  agent_name?: string;
  text: string;
  mentions?: string[];
  metadata?: Record<string, unknown> | null;
  created_at?: string;
};

function normalizeChannelName(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/^#/, '');
}

function isActionGenerated(message: TriggerMessage): boolean {
  const metadata = message.metadata ?? {};
  return (
    metadata.action_generated === true ||
    metadata.relaycast_action === true ||
    metadata.source === 'action' ||
    typeof metadata.action_invocation_id === 'string' ||
    typeof metadata.trigger_id === 'string'
  );
}

function matchesTrigger(trigger: TriggerRow, message: TriggerMessage): boolean {
  const channel = normalizeChannelName(trigger.channel);
  if (channel && channel !== normalizeChannelName(message.channel_name) && channel !== message.channel_id) return false;
  if (trigger.mention && (!message.mentions || message.mentions.length === 0)) return false;
  if (trigger.pattern) {
    try {
      if (!new RegExp(trigger.pattern).test(message.text)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isRateLimited(trigger: TriggerRow, nowMs: number): boolean {
  return !!trigger.last_triggered_at && nowMs - trigger.last_triggered_at * 1000 < TRIGGER_RATE_LIMIT_MS;
}

function isNodeLive(row: ActionNodeRow): boolean {
  return (
    row.node_status === 'online' &&
    row.handlers_live === 1 &&
    !!row.last_heartbeat_at &&
    Date.now() - row.last_heartbeat_at * 1000 <= 45_000
  );
}

function extractMessage(event: Record<string, unknown>, channelId: string, channelName: string): TriggerMessage | null {
  const raw = event.message;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  const id = typeof message.id === 'string' ? message.id : null;
  const agentId = typeof message.agent_id === 'string' ? message.agent_id : null;
  const text = typeof message.text === 'string' ? message.text : typeof message.body === 'string' ? message.body : null;
  if (!id || !agentId || text === null) return null;
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : null;
  return {
    id,
    channel_id: typeof message.channel_id === 'string' ? message.channel_id : channelId,
    channel_name: typeof message.channel_name === 'string' ? message.channel_name : channelName,
    agent_id: agentId,
    ...(typeof message.agent_name === 'string' ? { agent_name: message.agent_name } : {}),
    text,
    mentions: Array.isArray(message.mentions) ? message.mentions.filter((entry): entry is string => typeof entry === 'string') : [],
    metadata,
    created_at: typeof message.created_at === 'string' ? message.created_at : new Date().toISOString(),
  };
}

async function channelNameFor(env: CloudflareBindings, workspaceId: string, channelId: string): Promise<string> {
  const row = await env.DB
    .prepare('SELECT name FROM channels WHERE workspace_id = ? AND id = ? LIMIT 1')
    .bind(workspaceId, channelId)
    .first<{ name: string }>();
  return row?.name ?? channelId;
}

async function findActionNode(env: CloudflareBindings, workspaceId: string, actionName: string): Promise<ActionNodeRow | null> {
  return await env.DB
    .prepare(`
      SELECT a.id AS action_id, a.name AS action_name, a.handler_node_id,
             n.status AS node_status, n.handlers_live, n.last_heartbeat_at
      FROM actions a
      JOIN nodes n ON n.id = a.handler_node_id
      WHERE a.workspace_id = ? AND a.name = ? AND a.is_active = 1 AND a.handler_node_id IS NOT NULL
      LIMIT 1
    `)
    .bind(workspaceId, actionName)
    .first<ActionNodeRow>();
}

async function dispatchTriggeredAction(
  env: CloudflareBindings,
  workspaceId: string,
  trigger: TriggerRow,
  message: TriggerMessage,
): Promise<void> {
  const action = await findActionNode(env, workspaceId, trigger.action_name);
  if (!action || !isNodeLive(action)) return;

  const invocationId = generateFleetId('inv');
  const input = {
    trigger_id: trigger.id,
    message,
  };
  const now = Math.floor(Date.now() / 1000);

  await env.DB
    .prepare(`
      INSERT INTO action_invocations (
        id, workspace_id, action_id, action_name, caller_id, caller_name,
        input, status, dispatched_node_id, dispatched_at, attempted_node_ids,
        dispatch_attempts, retry_after_at, spawn_reserved_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, '[]', 0, NULL, NULL, ?)
    `)
    .bind(
      invocationId,
      workspaceId,
      action.action_id,
      action.action_name,
      message.agent_id,
      message.agent_name ?? null,
      JSON.stringify(input),
      now,
    )
    .run();

  const delivered = await sendToNode(env, workspaceId, action.handler_node_id, {
    v: 1,
    type: 'action.invoke',
    invocation_id: invocationId,
    action: action.action_name,
    input: toFleetJson(input),
  });

  if (delivered) {
    await env.DB
      .prepare(`
        UPDATE action_invocations
        SET status = 'dispatched',
            dispatched_node_id = ?,
            dispatched_at = ?,
            attempted_node_ids = ?,
            dispatch_attempts = COALESCE(dispatch_attempts, 0) + 1
        WHERE workspace_id = ? AND id = ?
      `)
      .bind(action.handler_node_id, now, JSON.stringify([action.handler_node_id]), workspaceId, invocationId)
      .run();
  } else {
    await env.DB
      .prepare(`
        UPDATE action_invocations
        SET status = 'failed', error = 'delivery_failed', completed_at = ?
        WHERE workspace_id = ? AND id = ?
      `)
      .bind(now, workspaceId, invocationId)
      .run();
  }
}

export async function fireFleetTriggersFromChannelBroadcast(
  env: CloudflareBindings,
  workspaceId: string,
  channelId: string,
  event: Record<string, unknown>,
): Promise<void> {
  if (event.type !== 'message.created' && event.type !== 'thread.reply' && event.type !== 'message') return;
  const channelName = await channelNameFor(env, workspaceId, channelId);
  const message = extractMessage(event, channelId, channelName);
  if (!message || isActionGenerated(message)) return;

  const triggers = await env.DB
    .prepare('SELECT id, channel, pattern, mention, action_name, last_triggered_at FROM triggers WHERE workspace_id = ? AND enabled = 1')
    .bind(workspaceId)
    .all<TriggerRow>();
  const nowMs = Date.now();

  for (const trigger of triggers.results ?? []) {
    if (!matchesTrigger(trigger, message) || isRateLimited(trigger, nowMs)) continue;

    await env.DB
      .prepare('UPDATE triggers SET last_triggered_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .bind(Math.floor(nowMs / 1000), Math.floor(nowMs / 1000), workspaceId, trigger.id)
      .run();

    try {
      await dispatchTriggeredAction(env, workspaceId, trigger, message);
    } catch {
      // Message persistence and realtime fanout already succeeded; trigger dispatch is best effort.
    }
  }
}
