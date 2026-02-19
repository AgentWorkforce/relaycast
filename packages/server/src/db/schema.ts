import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// ============================================
// Workspaces
// ============================================
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  systemPrompt: text('system_prompt'),
  plan: text('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  metadata: text('metadata', { mode: 'json' }).default('{}'),
});

// ============================================
// Agents
// ============================================
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull().default('agent'),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status').notNull().default('online'),
    persona: text('persona'),
    metadata: text('metadata', { mode: 'json' }).default('{}'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('agents_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_agents_workspace').on(table.workspaceId),
    index('idx_agents_token').on(table.tokenHash),
  ],
);

// ============================================
// Channels
// ============================================
export const channels = sqliteTable(
  'channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelType: integer('channel_type').notNull().default(0),
    topic: text('topic'),
    createdBy: text('created_by').references(() => agents.id),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    uniqueIndex('channels_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_channels_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Channel Members
// ============================================
export const channelMembers = sqliteTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastReadId: text('last_read_id'),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.agentId] }),
    index('idx_channel_members_agent').on(table.agentId),
  ],
);

// ============================================
// Messages
// ============================================
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    threadId: text('thread_id').references((): AnySQLiteColumn => messages.id),
    body: text('body').notNull(),
    blocks: text('blocks', { mode: 'json' }),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
    // FTS5 search handled via separate virtual table + triggers
  },
  (table) => [
    index('idx_messages_channel_time').on(table.channelId, table.id),
    index('idx_messages_thread').on(table.threadId, table.id),
    index('idx_messages_workspace').on(table.workspaceId, table.id),
  ],
);

// ============================================
// Reactions
// ============================================
export const reactions = sqliteTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('reactions_message_agent_emoji_unique').on(
      table.messageId,
      table.agentId,
      table.emoji,
    ),
    index('idx_reactions_message').on(table.messageId),
  ],
);

// ============================================
// DM Conversations
// ============================================
export const dmConversations = sqliteTable(
  'dm_conversations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    dmType: text('dm_type').notNull().default('1:1'),
    name: text('name'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_dm_conversations_workspace').on(table.workspaceId),
  ],
);

// ============================================
// DM Participants
// ============================================
export const dmParticipants = sqliteTable(
  'dm_participants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => dmConversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    joinedAt: integer('joined_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    leftAt: integer('left_at', { mode: 'timestamp' }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.agentId] }),
    index('idx_dm_participants_agent').on(table.agentId),
  ],
);

// ============================================
// Files
// ============================================
export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => agents.id),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_files_workspace').on(table.workspaceId, table.createdAt),
    index('idx_files_uploader').on(table.uploadedBy),
  ],
);

// ============================================
// Message Attachments (junction table)
// ============================================
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.fileId] }),
    index('idx_message_attachments_file').on(table.fileId),
  ],
);

// ============================================
// Read Receipts
// ============================================
export const readReceipts = sqliteTable(
  'read_receipts',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    readAt: integer('read_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.agentId] }),
    index('idx_read_receipts_message').on(table.messageId),
    index('idx_read_receipts_agent').on(table.agentId, table.readAt),
  ],
);

// ============================================
// Usage Records
// ============================================
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    periodStart: integer('period_start', { mode: 'timestamp' }).notNull(),
    periodEnd: integer('period_end', { mode: 'timestamp' }).notNull(),
    messagesSent: integer('messages_sent').notNull().default(0),
    apiCalls: integer('api_calls').notNull().default(0),
    filesUploaded: integer('files_uploaded').notNull().default(0),
    fileBytes: integer('file_bytes').notNull().default(0),
    wsMinutes: integer('ws_minutes').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_usage_workspace_period').on(table.workspaceId, table.periodStart),
  ],
);

// ============================================
// Inbound Webhooks
// ============================================
export const webhooks = sqliteTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').references(() => agents.id),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('webhooks_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_webhooks_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Outbound Event Subscriptions
// ============================================
export const eventSubscriptions = sqliteTable(
  'event_subscriptions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    events: text('events', { mode: 'json' }).notNull().$type<string[]>(),
    filter: text('filter', { mode: 'json' }).$type<{ channel?: string; mentions?: string }>(),
    url: text('url').notNull(),
    secret: text('secret'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_event_subscriptions_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Agent Commands
// ============================================
export const commands = sqliteTable(
  'commands',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    description: text('description').notNull(),
    handlerAgentId: text('handler_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    parameters: text('parameters', { mode: 'json' })
      .$type<
        Array<{
          name: string;
          description?: string;
          type: string;
          required?: boolean;
        }>
      >()
      .default([]),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('commands_workspace_command_unique').on(
      table.workspaceId,
      table.command,
    ),
    index('idx_commands_workspace').on(table.workspaceId),
    index('idx_commands_handler').on(table.handlerAgentId),
  ],
);

// ============================================
// Pending Events (durable event queue)
// ============================================
export const pendingEvents = sqliteTable(
  'pending_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    processAfter: integer('process_after', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_pending_events_status').on(table.status, table.processAfter),
    index('idx_pending_events_workspace').on(table.workspaceId),
  ],
);
