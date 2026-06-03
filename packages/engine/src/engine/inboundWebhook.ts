import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { webhooks, channels, messages, agents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';
import { inboundWebhookMessageMetadata } from './messageMetadata.js';

type Db = ReturnType<typeof getDb>;
const WEBHOOK_AGENT_NAME = '__relay_webhook__';

async function ensureWebhookAgent(db: Db, workspaceId: string): Promise<string> {
  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, WEBHOOK_AGENT_NAME)));

  if (existing) return existing.id;

  const token = `at_live_${randomHex(16)}`;
  const tokenHash = await sha256Hex(token);
  const agentId = generateId();

  await db
    .insert(agents)
    .values({
      id: agentId,
      workspaceId,
      name: WEBHOOK_AGENT_NAME,
      type: 'system',
      tokenHash,
      status: 'offline',
      persona: 'System identity for inbound webhook messages',
      metadata: { system: true, purpose: 'inbound_webhook' },
    })
    .onConflictDoNothing();

  const [created] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, WEBHOOK_AGENT_NAME)));

  if (!created) {
    throw codedError('Failed to provision inbound webhook agent identity', 'webhook_agent_provision_failed', 500);
  }

  return created.id;
}

export async function createWebhook(
  db: Db,
  workspaceId: string,
  channelId: string,
  data: { name?: string },
  createdBy?: string,
) {
  const id = `wh_${generateId()}`;
  const token = `wh_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const postingAgentId = createdBy ?? await ensureWebhookAgent(db, workspaceId);

  const [webhook] = await db
    .insert(webhooks)
    .values({
      id,
      workspaceId,
      channelId,
      name: data.name ?? id,
      createdBy: postingAgentId,
      tokenHash,
    })
    .returning();

  // Get channel name for response
  const [channel] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId));

  return {
    webhook_id: webhook.id,
    name: webhook.name,
    channel: channel?.name || '',
    url: `/v1/hooks/${webhook.id}`,
    token,
    is_active: webhook.isActive,
    created_at: webhook.createdAt.toISOString(),
  };
}

export async function listWebhooks(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      id: webhooks.id,
      name: webhooks.name,
      channelId: webhooks.channelId,
      channelName: channels.name,
      isActive: webhooks.isActive,
      createdBy: webhooks.createdBy,
      createdAt: webhooks.createdAt,
    })
    .from(webhooks)
    .innerJoin(channels, eq(webhooks.channelId, channels.id))
    .where(eq(webhooks.workspaceId, workspaceId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    channel: r.channelName,
    url: `/v1/hooks/${r.id}`,
    is_active: r.isActive,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getWebhook(db: Db, workspaceId: string, webhookId: string) {
  const [row] = await db
    .select({
      id: webhooks.id,
      name: webhooks.name,
      channelId: webhooks.channelId,
      channelName: channels.name,
      isActive: webhooks.isActive,
      createdBy: webhooks.createdBy,
      createdAt: webhooks.createdAt,
    })
    .from(webhooks)
    .innerJoin(channels, eq(webhooks.channelId, channels.id))
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)));

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    channel: row.channelName,
    url: `/v1/hooks/${row.id}`,
    is_active: row.isActive,
    created_at: row.createdAt.toISOString(),
  };
}

export async function deleteWebhook(db: Db, workspaceId: string, webhookId: string) {
  const result = await db
    .delete(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.workspaceId, workspaceId)))
    .returning();

  return result.length > 0;
}

export async function triggerWebhook(
  db: Db,
  webhookId: string,
  token: string | null,
  data: { text?: string; source?: string; author?: string; payload?: Record<string, unknown> },
) {
  // Look up webhook
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.isActive, true)));

  if (!webhook) return null;
  if (webhook.tokenHash) {
    if (!token) {
      throw codedError('Webhook bearer token required', 'webhook_token_required', 401);
    }
    const tokenHash = await sha256Hex(token);
    if (tokenHash !== webhook.tokenHash) {
      throw codedError('Invalid webhook bearer token', 'webhook_token_invalid', 401);
    }
  }

  // Build message text from payload or text
  const text =
    data.text ||
    (data.payload
      ? `Webhook ${webhook.name}: ${JSON.stringify(data.payload)}`
      : `Webhook event from ${data.source || 'external'}`);
  const author = data.author || data.source || webhook.name;

  // Webhook must have a creator agent to post messages
  if (!webhook.createdBy) {
    throw codedError('Webhook has no associated agent and cannot post messages', 'webhook_no_agent', 422);
  }

  // Create message in the bound channel using the webhook creator's identity
  const messageId = generateId();
  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      workspaceId: webhook.workspaceId,
      channelId: webhook.channelId,
      agentId: webhook.createdBy,
      body: text,
      metadata: inboundWebhookMessageMetadata({
        webhookId: webhook.id,
        webhookName: webhook.name,
        source: data.source ?? null,
        author,
      }),
    })
    .returning();

  // Get channel name
  const [channel] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, webhook.channelId));

  return {
    message_id: message.id,
    webhook_id: webhook.id,
    workspace_id: webhook.workspaceId,
    channel_id: webhook.channelId,
    channel: channel?.name || '',
    text: message.body,
    source: data.source || null,
    author,
    created_at: message.createdAt.toISOString(),
  };
}
