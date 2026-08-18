import { eq, and } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { webhooks, channels, messages, agents } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';
import { inboundWebhookMessageMetadata, sanitizeUserMessageMetadata } from './messageMetadata.js';
import { runAtomicWrites, type AtomicWrite } from '../ports/database.js';
import { buildChannelDeliveryWrite, fetchChannelDeliveryOutcomes } from './deliveryWrites.js';
import { DEFAULT_MAILBOX_DEPTH_CAP, DEFAULT_MAILBOX_TTL_MS, type MailboxConfig } from './mailboxConfig.js';
import { buildMessageSessionWrite, sessionRefFromMetadata } from './sessionMessages.js';

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
  const postingAgentId = webhook.createdBy;

  // Create message in the bound channel using the webhook creator's identity
  const messageId = generateId();
  const metadata = {
    ...inboundWebhookMessageMetadata({
      webhookId: webhook.id,
      webhookName: webhook.name,
      source: data.source ?? null,
      author,
    }),
    ...sanitizeUserMessageMetadata(data.payload),
  };
  const sessionRef = sessionRefFromMetadata(metadata);
  const createdAt = new Date();
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb
        .insert(messages)
        .values({
          id: messageId,
          workspaceId: webhook.workspaceId,
          channelId: webhook.channelId,
          agentId: postingAgentId,
          body: text,
          metadata,
          sessionRef,
          createdAt,
        })
        .returning(),
    ];
    const sessionWrite = buildMessageSessionWrite(
      writeDb,
      webhook.workspaceId,
      sessionRef,
      createdAt,
    );
    if (sessionWrite) writes.push(sessionWrite);
    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];

  // Get channel name
  const [channel] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, webhook.channelId));

  return {
    message_id: message.id,
    agent_id: message.agentId,
    webhook_id: webhook.id,
    workspace_id: webhook.workspaceId,
    channel_id: webhook.channelId,
    channel: channel?.name || '',
    text: message.body,
    source: data.source || null,
    author,
    created_at: message.createdAt.toISOString(),
    metadata: sanitizeUserMessageMetadata(data.payload),
  };
}

export async function triggerIntegrationMessage(
  db: Db,
  workspaceId: string,
  channelId: string,
  data: {
    text: string;
    source: string;
    author: string;
    payload?: Record<string, unknown>;
    webhookId?: string;
    webhookName?: string;
    mode?: 'wait' | 'steer';
  },
  options: { mailbox?: MailboxConfig } = {},
) {
  const postingAgentId = await ensureWebhookAgent(db, workspaceId);
  const messageId = generateId();
  const webhookId = data.webhookId ?? `relayfile:${data.source}`;
  const webhookName = data.webhookName ?? data.source;
  const metadata = {
    ...inboundWebhookMessageMetadata({
      webhookId,
      webhookName,
      source: data.source,
      author: data.author,
    }),
    ...sanitizeUserMessageMetadata(data.payload),
  };
  const sessionRef = sessionRefFromMetadata(metadata);
  const createdAt = new Date();

  const mailbox = options.mailbox ?? {
    ttlMs: DEFAULT_MAILBOX_TTL_MS,
    depthCap: DEFAULT_MAILBOX_DEPTH_CAP,
  };

  // Insert the message AND compute channel deliveries in one atomic unit — the
  // delivery rows are what `routeDeliveryOutcomes` dispatches to node-connected
  // agents. A bare insert (the previous behavior) produced no deliveries, so
  // broker/node agents never received inbound integration messages.
  const results = await runAtomicWrites(db, (writeDb) => {
    const writes: AtomicWrite[] = [
      writeDb
        .insert(messages)
        .values({
          id: messageId,
          workspaceId,
          channelId,
          agentId: postingAgentId,
          body: data.text,
          metadata,
          sessionRef,
          createdAt,
        })
        .returning(),
    ];

    const sessionWrite = buildMessageSessionWrite(
      writeDb,
      workspaceId,
      sessionRef,
      createdAt,
    );
    if (sessionWrite) writes.push(sessionWrite);

    writes.push(
      buildChannelDeliveryWrite(writeDb, {
        workspaceId,
        messageId,
        channelId,
        senderAgentId: postingAgentId,
        mode: data.mode === 'steer' ? 'next-tool-call' : 'immediate',
        ttlMs: mailbox.ttlMs,
        depthCap: mailbox.depthCap,
      }),
    );

    return writes;
  });
  const [message] = results[0] as (typeof messages.$inferSelect)[];

  const [channel] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId));

  const outcomes = await fetchChannelDeliveryOutcomes(db, {
    messageId,
    channelId,
    senderAgentId: postingAgentId,
  });

  return {
    message_id: message.id,
    workspace_id: workspaceId,
    channel_id: channelId,
    channel: channel?.name || '',
    text: message.body,
    source: data.source,
    author: data.author,
    created_at: message.createdAt.toISOString(),
    metadata: sanitizeUserMessageMetadata(data.payload),
    _deliveries: outcomes.deliveries,
    _delivery_rejections: outcomes.rejections,
  };
}
