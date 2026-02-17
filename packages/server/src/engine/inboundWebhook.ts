import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { webhooks, channels, messages } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export async function createWebhook(
  db: Db,
  workspaceId: string,
  channelId: string,
  data: { name: string },
  createdBy?: string,
) {
  const id = `wh_${generateId()}`;

  const [webhook] = await db
    .insert(webhooks)
    .values({
      id,
      workspaceId,
      channelId,
      name: data.name,
      createdBy: createdBy || null,
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
  data: { text?: string; source?: string; payload?: Record<string, unknown> },
) {
  // Look up webhook
  const [webhook] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, webhookId), eq(webhooks.isActive, true)));

  if (!webhook) return null;

  // Build message text from payload or text
  const text =
    data.text ||
    (data.payload
      ? `Webhook ${webhook.name}: ${JSON.stringify(data.payload)}`
      : `Webhook event from ${data.source || 'external'}`);

  // Webhook must have a creator agent to post messages
  if (!webhook.createdBy) {
    const err = new Error('Webhook has no associated agent and cannot post messages');
    (err as Error & { code?: string; status?: number }).code = 'webhook_no_agent';
    (err as Error & { code?: string; status?: number }).status = 422;
    throw err;
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
    created_at: message.createdAt.toISOString(),
  };
}
