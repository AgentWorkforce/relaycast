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
  name: text('name').notNull(),
  apiKeyHash: text('api_key_hash').notNull().unique(),
  systemPrompt: text('system_prompt'),
  plan: text('plan').notNull().default('free'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
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
    status: text('status').notNull().default('active'),
    handle: text('handle'),
    persona: text('persona'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    capabilities: text('capabilities', { mode: 'json' }).$type<Record<string, unknown>>(),
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
// A2A Agents
// ============================================
export const a2aAgents = sqliteTable(
  'a2a_agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    relayAgentId: text('relay_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    agentCard: text('agent_card', { mode: 'json' }).notNull().default('{}'),
    externalUrl: text('external_url').notNull(),
    authScheme: text('auth_scheme'),
    authCredential: text('auth_credential'),
    status: text('status').notNull().default('active'),
    messagesSent: integer('messages_sent').notNull().default(0),
    messagesRecv: integer('messages_recv').notNull().default(0),
    lastHealth: integer('last_health', { mode: 'timestamp' }),
    healthFailures: integer('health_failures').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_a2a_agents_workspace').on(table.workspaceId),
    uniqueIndex('idx_a2a_agents_relay_agent').on(table.relayAgentId),
  ],
);

// ============================================
// Directory Agents
// ============================================
export const directoryAgents = sqliteTable(
  'directory_agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAgentId: text('source_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    provider: text('provider'),
    endpointUrl: text('endpoint_url'),
    documentationUrl: text('documentation_url'),
    version: text('version'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    capabilities: text('capabilities', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('active'),
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('directory_agents_workspace_slug_unique').on(table.workspaceId, table.slug),
    index('idx_directory_agents_workspace').on(table.workspaceId, table.createdAt),
    index('idx_directory_agents_source_agent').on(table.sourceAgentId),
    index('idx_directory_agents_status').on(table.workspaceId, table.status),
  ],
);

// ============================================
// Directory Skills
// ============================================
export const directorySkills = sqliteTable(
  'directory_skills',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    directoryAgentId: text('directory_agent_id')
      .notNull()
      .references(() => directoryAgents.id, { onDelete: 'cascade' }),
    skillId: text('skill_id'),
    name: text('name').notNull(),
    description: text('description'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    position: integer('position').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_directory_skills_agent').on(table.directoryAgentId, table.position),
    index('idx_directory_skills_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Directory Ratings
// ============================================
export const directoryRatings = sqliteTable(
  'directory_ratings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    directoryAgentId: text('directory_agent_id')
      .notNull()
      .references(() => directoryAgents.id, { onDelete: 'cascade' }),
    raterAgentId: text('rater_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    review: text('review'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('directory_ratings_agent_rater_unique').on(table.directoryAgentId, table.raterAgentId),
    index('idx_directory_ratings_workspace').on(table.workspaceId, table.createdAt),
    index('idx_directory_ratings_directory_agent').on(table.directoryAgentId, table.createdAt),
  ],
);

// ============================================
// Smart Routing
// ============================================
export const routingConfigs = sqliteTable(
  'routing_configs',
  {
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    weights: text('weights', { mode: 'json' }).notNull().default('{}'),
    circuitBreakerThreshold: integer('circuit_breaker_threshold').notNull().default(3),
    circuitBreakerCooldownSeconds: integer('circuit_breaker_cooldown_seconds').notNull().default(300),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_routing_configs_updated_at').on(table.updatedAt),
  ],
);

export const routingFailures = sqliteTable(
  'routing_failures',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    totalFailures: integer('total_failures').notNull().default(0),
    totalSuccesses: integer('total_successes').notNull().default(0),
    lastFailureAt: integer('last_failure_at', { mode: 'timestamp' }),
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp' }),
    circuitOpenUntil: integer('circuit_open_until', { mode: 'timestamp' }),
    lastError: text('last_error'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.agentId] }),
    index('idx_routing_failures_workspace').on(table.workspaceId, table.updatedAt),
    index('idx_routing_failures_circuit').on(table.workspaceId, table.circuitOpenUntil),
  ],
);

// ============================================
// Certifications
// ============================================
export const certifications = sqliteTable(
  'certifications',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentUrl: text('agent_url').notNull(),
    level: integer('level').notNull(),
    source: text('source').notNull().default('manual'),
    status: text('status').notNull().default('pending'),
    passed: integer('passed', { mode: 'boolean' }).notNull().default(false),
    passedTests: integer('passed_tests').notNull().default(0),
    totalTests: integer('total_tests').notNull().default(0),
    monitorEnabled: integer('monitor_enabled', { mode: 'boolean' }).notNull().default(false),
    monitorIntervalMinutes: integer('monitor_interval_minutes').notNull().default(60),
    lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
    results: text('results', { mode: 'json' }).default('[]'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_certifications_workspace').on(table.workspaceId, table.createdAt),
    index('idx_certifications_agent_url').on(table.agentUrl),
    index('idx_certifications_monitor_enabled').on(table.monitorEnabled, table.updatedAt),
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
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
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
    isMuted: integer('is_muted', { mode: 'boolean' }).notNull().default(false),
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
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
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
// Message Logs
// ============================================
export const messageLogs = sqliteTable(
  'message_logs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    deliveryKind: text('delivery_kind').notNull(),
    body: text('body').notNull(),
    contentType: text('content_type'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    attachmentCount: integer('attachment_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('message_logs_message_unique').on(table.messageId),
    index('idx_message_logs_workspace_time').on(table.workspaceId, table.id),
    index('idx_message_logs_agent_time').on(table.agentId, table.id),
    index('idx_message_logs_channel_time').on(table.channelId, table.id),
    index('idx_message_logs_conversation_time').on(table.conversationId, table.id),
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
// Actions (typed agent capabilities)
// ============================================
export const actions = sqliteTable(
  'actions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    handlerAgentId: text('handler_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    inputSchema: text('input_schema', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    outputSchema: text('output_schema', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    availableTo: text('available_to', { mode: 'json' }).$type<string[]>(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('actions_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_actions_workspace').on(table.workspaceId),
    index('idx_actions_handler').on(table.handlerAgentId),
  ],
);

// ============================================
// Action Invocations (audit log)
// ============================================
export const actionInvocations = sqliteTable(
  'action_invocations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actionId: text('action_id').references(() => actions.id, { onDelete: 'set null' }),
    actionName: text('action_name').notNull(),
    callerId: text('caller_id').references(() => agents.id, { onDelete: 'set null' }),
    callerName: text('caller_name'),
    input: text('input', { mode: 'json' }).default({}),
    output: text('output', { mode: 'json' }),
    status: text('status').notNull().default('invoked'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_action_invocations_workspace').on(table.workspaceId, table.createdAt),
    index('idx_action_invocations_action').on(table.actionId, table.createdAt),
    index('idx_action_invocations_caller').on(table.callerId, table.createdAt),
  ],
);

// ============================================
// Session Events (harness-emitted observations)
// ============================================
export const sessionEvents = sqliteTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull().default({}),
    sequence: integer('sequence').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('session_events_agent_sequence_unique').on(table.agentId, table.sequence),
    index('idx_session_events_agent').on(table.agentId, table.createdAt),
    index('idx_session_events_workspace').on(table.workspaceId, table.createdAt),
    index('idx_session_events_type').on(table.workspaceId, table.type, table.createdAt),
  ],
);

// ============================================
// Deliveries (per-recipient message delivery tracking)
// ============================================
export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('immediate'),
    reason: text('reason'),
    priority: text('priority').notNull().default('normal'),
    deadline: integer('deadline', { mode: 'timestamp' }),
    status: text('status').notNull().default('accepted'),
    retryable: integer('retryable', { mode: 'boolean' }),
    availableAt: integer('available_at', { mode: 'timestamp' }),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('deliveries_message_agent_unique').on(table.messageId, table.agentId),
    index('idx_deliveries_agent').on(table.agentId, table.createdAt),
    index('idx_deliveries_status').on(table.workspaceId, table.status, table.createdAt),
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
