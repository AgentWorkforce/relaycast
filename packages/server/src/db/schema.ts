import {
  pgTable,
  text,
  boolean,
  smallint,
  bigint,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Custom tsvector type for full-text search
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ============================================
// Workspaces
// ============================================
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  systemPrompt: text('system_prompt'),
  plan: text('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').default({}),
});

// ============================================
// Agents
// ============================================
export const agents = pgTable(
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
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
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
export const channels = pgTable(
  'channels',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelType: smallint('channel_type').notNull().default(0),
    topic: text('topic'),
    createdBy: text('created_by').references(() => agents.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    isArchived: boolean('is_archived').notNull().default(false),
  },
  (table) => [
    uniqueIndex('channels_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_channels_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Channel Members
// ============================================
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
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
export const messages = pgTable(
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
    threadId: text('thread_id').references((): AnyPgColumn => messages.id),
    body: text('body').notNull(),
    blocks: jsonb('blocks'),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', body)`,
    ),
  },
  (table) => [
    index('idx_messages_channel_time').on(table.channelId, table.id.desc()),
    index('idx_messages_thread').on(table.threadId, table.id.desc()).where(sql`thread_id IS NOT NULL`),
    index('idx_messages_workspace').on(table.workspaceId, table.id.desc()),
    index('idx_messages_fts').using('gin', table.searchVector),
  ],
);

// ============================================
// Reactions
// ============================================
export const reactions = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
export const dmConversations = pgTable(
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_dm_conversations_workspace').on(table.workspaceId),
  ],
);

// ============================================
// DM Participants
// ============================================
export const dmParticipants = pgTable(
  'dm_participants',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => dmConversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.agentId] }),
    index('idx_dm_participants_agent').on(table.agentId),
  ],
);

// ============================================
// Files
// ============================================
export const files = pgTable(
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
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_files_workspace').on(table.workspaceId, table.createdAt),
    index('idx_files_uploader').on(table.uploadedBy),
  ],
);

// ============================================
// Message Attachments (junction table)
// ============================================
export const messageAttachments = pgTable(
  'message_attachments',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.fileId] }),
    index('idx_message_attachments_file').on(table.fileId),
  ],
);

// ============================================
// Read Receipts
// ============================================
export const readReceipts = pgTable(
  'read_receipts',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
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
export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    messagesSent: bigint('messages_sent', { mode: 'number' }).notNull().default(0),
    apiCalls: bigint('api_calls', { mode: 'number' }).notNull().default(0),
    filesUploaded: bigint('files_uploaded', { mode: 'number' }).notNull().default(0),
    fileBytes: bigint('file_bytes', { mode: 'number' }).notNull().default(0),
    wsMinutes: bigint('ws_minutes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_usage_workspace_period').on(table.workspaceId, table.periodStart),
  ],
);

// ============================================
// Inbound Webhooks
// ============================================
export const webhooks = pgTable(
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
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhooks_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_webhooks_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Outbound Event Subscriptions
// ============================================
export const eventSubscriptions = pgTable(
  'event_subscriptions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    events: jsonb('events').notNull().$type<string[]>(),
    filter: jsonb('filter').$type<{ channel?: string; mentions?: string }>(),
    url: text('url').notNull(),
    secret: text('secret'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_event_subscriptions_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Agent Commands
// ============================================
export const commands = pgTable(
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
    parameters: jsonb('parameters')
      .$type<
        Array<{
          name: string;
          description?: string;
          type: string;
          required?: boolean;
        }>
      >()
      .default([]),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
