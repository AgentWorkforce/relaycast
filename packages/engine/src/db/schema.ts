import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { FleetCapability, WorkspaceProvenance } from '@relaycast/types';

// ============================================
// Workspaces
// ============================================
/**
 * Per-workspace retention TTLs (days), stored in `workspaces.retention`.
 * `undefined` inherits the deployment default; explicit `null` disables
 * pruning for that table even when a deployment default exists.
 */
export interface WorkspaceRetentionSettings {
  message_ttl_days?: number | null;
  delivery_ttl_days?: number | null;
  message_log_ttl_days?: number | null;
  workspace_event_ttl_days?: number | null;
}

export type WorkspaceProvenanceRecord = WorkspaceProvenance;

export interface ObserverTokenFilters {
  channel_ids?: string[];
  channel_names?: string[];
  include_dms?: boolean;
  dm_conversation_ids?: string[];
  agent_ids?: string[];
  event_types?: string[];
  created_after?: string;
}

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    apiKeyHash: text('api_key_hash').notNull().unique(),
    systemPrompt: text('system_prompt'),
    plan: text('plan').notNull().default('free'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    retention: text('retention', { mode: 'json' }).$type<WorkspaceRetentionSettings>(),
    // A non-null deadline is an explicit, immutable opt-in to whole-workspace
    // deletion. Persistent workspaces always leave this null.
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    provenance: text('provenance', { mode: 'json' }).$type<WorkspaceProvenanceRecord>(),
    usageClassification: text('usage_classification').notNull().default('unknown'),
    classificationSource: text('classification_source').notNull().default('unclassified'),
    classificationReason: text('classification_reason'),
    classifiedAt: integer('classified_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_workspaces_expires_at').on(table.expiresAt),
    check(
      'workspaces_usage_classification_source_check',
      sql`(
        (${table.usageClassification} = 'unknown' AND ${table.classificationSource} = 'unclassified')
        OR (
          ${table.usageClassification} IN ('internal', 'external')
          AND ${table.classificationSource} IN ('creator', 'operator')
        )
      )`,
    ),
  ],
);

/**
 * Durable owner-scoped idempotency bindings for delegated workspace creates.
 * The child API key is derived at replay time and is never persisted in
 * plaintext.
 */
export const workspaceCreateIdempotency = sqliteTable(
  'workspace_create_idempotency',
  {
    ownerScopeHash: text('owner_scope_hash').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    requestDigest: text('request_digest').notNull(),
    workspaceId: text('workspace_id').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    terminalizedAt: integer('terminalized_at', { mode: 'timestamp' }),
  },
  (table) => [
    primaryKey({ columns: [table.ownerScopeHash, table.idempotencyKeyHash] }),
    uniqueIndex('workspace_create_idempotency_workspace_unique').on(table.workspaceId),
  ],
);

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
    // Superseded credential retained during the rotation grace window. See
    // migration 0035 for the concurrency defect this closes (relay#1542).
    previousTokenHash: text('previous_token_hash'),
    previousTokenExpiresAt: integer('previous_token_expires_at', { mode: 'timestamp' }),
    status: text('status').notNull().default('active'),
    handle: text('handle'),
    persona: text('persona'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    capabilities: text('capabilities', { mode: 'json' }).$type<Record<string, unknown>>(),
    locationType: text('location_type').notNull().default('self_connected'),
    locationNodeId: text('location_node_id').references((): AnySQLiteColumn => nodes.id, { onDelete: 'set null' }),
    // The node provider whose connection registered this agent. `deliver` frames
    // route to that provider's socket. Defaults to the synthetic `default`
    // provider (the broker) for agents registered before the provider model.
    providerName: text('provider_name').notNull().default('default'),
    resumable: integer('resumable', { mode: 'boolean' }).notNull().default(false),
    sessionRef: text('session_ref'),
    originNodeId: text('origin_node_id').references((): AnySQLiteColumn => nodes.id, { onDelete: 'set null' }),
    deliveryAckSeq: integer('delivery_ack_seq').notNull().default(0),
    // Durable allocation high-water. Unlike MAX(deliveries.seq), this survives
    // settled-delivery pruning and message-retention cascades.
    deliverySeq: integer('delivery_seq').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    lastSeen: integer('last_seen', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('agents_workspace_name_unique').on(table.workspaceId, table.name),
    uniqueIndex('agents_workspace_id_unique').on(table.workspaceId, table.id),
    index('idx_agents_workspace').on(table.workspaceId),
    index('idx_agents_token').on(table.tokenHash),
    index('idx_agents_previous_token').on(table.previousTokenHash),
    index('idx_agents_active_last_seen')
      .on(table.lastSeen)
      .where(sql`${table.status} IN ('active', 'online')`),
  ],
);

// ============================================
// Agent Identity Recovery
// ============================================
/**
 * Server-owned verifier state for explicit identity recovery.
 *
 * This deliberately does not live in `agents.metadata`: generic metadata is a
 * caller-facing document and therefore cannot be an authorization boundary.
 * Raw recovery proofs are never stored; callers present the proof and the
 * engine compares its SHA-256 verifier.
 */
export const agentRecoveryCredentials = sqliteTable(
  'agent_recovery_credentials',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    proofKind: text('proof_kind').notNull(),
    verifierHash: text('verifier_hash').notNull(),
    workUnitId: text('work_unit_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('agent_recovery_credentials_agent_unique').on(table.workspaceId, table.agentId),
    uniqueIndex('agent_recovery_credentials_verifier_unique').on(table.verifierHash),
    foreignKey({
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
      name: 'agent_recovery_credentials_agent_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Append-only security record. There is intentionally no agent foreign key:
 * an identity audit must survive release/deletion and retention pruning.
 */
export const agentIdentityAudit = sqliteTable(
  'agent_identity_audit',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    agentName: text('agent_name').notNull(),
    action: text('action').notNull(),
    authority: text('authority').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull(),
    sessionRef: text('session_ref'),
    nodeId: text('node_id'),
    originActor: text('origin_actor').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_agent_identity_audit_workspace').on(table.workspaceId, table.createdAt),
    index('idx_agent_identity_audit_agent').on(table.workspaceId, table.agentId, table.createdAt),
  ],
);

// ============================================
// Nodes
// ============================================
export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    // Physical machine grouping in fleet views and a placement input; never a
    // capability scope. Set at enrollment when the caller supplies it, and by a
    // provider on register; null when neither reports one.
    machineId: text('machine_id'),
    kind: text('kind').notNull().default('ws'),
    role: text('role').notNull().default('broker'),
    deliveryAdapter: text('delivery_adapter').notNull().default('ws.node.v1'),
    deliveryConfig: text('delivery_config', { mode: 'json' }).$type<Record<string, unknown>>(),
    capabilities: text('capabilities', { mode: 'json' }).$type<FleetCapability[]>().notNull().default([]),
    // Zero is the fleet-wide sentinel for unlimited capacity.
    maxAgents: integer('max_agents').notNull().default(0),
    activeAgents: integer('active_agents').notNull().default(0),
    reservedAgents: integer('reserved_agents').notNull().default(0),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    version: text('version').notNull().default('unknown'),
    status: text('status').notNull().default('offline'),
    handlersLive: integer('handlers_live', { mode: 'boolean' }).notNull().default(false),
    load: real('load').notNull().default(0),
    loadReported: integer('load_reported', { mode: 'boolean' }).notNull().default(false),
    lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp' }),
    // Written ONLY by an arriving heartbeat frame — never by registration or
    // disconnect cleanup, both of which write lastHeartbeatAt. Cleared when
    // enrollment re-issues this row's token. This is the only column that means
    // "this node proved it was alive", and the machine_id reuse gate reads it.
    provenLiveAt: integer('proven_live_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('nodes_workspace_name_unique').on(table.workspaceId, table.name),
    uniqueIndex('nodes_workspace_id_unique').on(table.workspaceId, table.id),
    index('idx_nodes_workspace').on(table.workspaceId),
    index('idx_nodes_token').on(table.tokenHash),
    index('idx_nodes_status').on(table.workspaceId, table.status),
    index('idx_nodes_workspace_machine').on(table.workspaceId, table.machineId),
    index('idx_nodes_workspace_machine_proven').on(table.workspaceId, table.machineId, table.provenLiveAt),
  ],
);

// ============================================
// Node Providers
// ============================================
/**
 * A process attached to a broker-role node, keyed by provider `name`. Each
 * provider registers a subset of the node's capabilities and executes their
 * invokes over its own socket. `instanceId` is the connection epoch. Capability
 * sets persist here so an offline node still displays its full manifest, and the
 * per-provider liveness/capacity/load columns are aggregated onto the `nodes`
 * row. Implicit direct nodes (per self-connected agent) do not use this table.
 */
export const nodeProviders = sqliteTable(
  'node_providers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instanceId: text('instance_id').notNull(),
    capabilities: text('capabilities', { mode: 'json' }).$type<FleetCapability[]>().notNull().default([]),
    // Zero is the fleet-wide sentinel for unlimited provider capacity.
    maxAgents: integer('max_agents').notNull().default(0),
    activeAgents: integer('active_agents').notNull().default(0),
    load: real('load').notNull().default(0),
    loadReported: integer('load_reported', { mode: 'boolean' }).notNull().default(false),
    handlersLive: integer('handlers_live', { mode: 'boolean' }).notNull().default(false),
    status: text('status').notNull().default('offline'),
    version: text('version').notNull().default('unknown'),
    lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('node_providers_node_name_unique').on(table.workspaceId, table.nodeId, table.name),
    index('idx_node_providers_node').on(table.workspaceId, table.nodeId),
  ],
);

// ============================================
// Observer Tokens
// ============================================
export const observerTokens = sqliteTable(
  'observer_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    tokenHash: text('token_hash').notNull().unique(),
    scopes: text('scopes', { mode: 'json' }).$type<string[]>().notNull().default([]),
    filters: text('filters', { mode: 'json' }).$type<ObserverTokenFilters>().notNull().default({}),
    status: text('status').notNull().default('active'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdBy: text('created_by'),
    createdByType: text('created_by_type').notNull().default('workspace'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('observer_tokens_workspace_name_unique').on(table.workspaceId, table.name),
    uniqueIndex('observer_tokens_token_hash_unique').on(table.tokenHash),
    index('idx_observer_tokens_workspace_status').on(table.workspaceId, table.status),
    index('idx_observer_tokens_expires_at').on(table.expiresAt),
  ],
);

// ============================================
// Agent Node Bindings
// ============================================
export const agentNodeBindings = sqliteTable(
  'agent_node_bindings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('active'),
    sessionRef: text('session_ref'),
    priority: integer('priority').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('agent_node_bindings_agent_node_unique').on(table.agentId, table.nodeId),
    foreignKey({
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
      name: 'agent_node_bindings_agent_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.workspaceId, table.nodeId],
      foreignColumns: [nodes.workspaceId, nodes.id],
      name: 'agent_node_bindings_node_workspace_fk',
    }).onDelete('cascade'),
    index('idx_agent_node_bindings_workspace').on(table.workspaceId, table.status),
    index('idx_agent_node_bindings_agent').on(table.workspaceId, table.agentId, table.status),
    index('idx_agent_node_bindings_node').on(table.workspaceId, table.nodeId, table.status),
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
    // Denormalized from public metadata.session_ref at write time. Keeping the
    // join key in a real column makes replay lookup bounded and index-backed;
    // callers must never scan JSON metadata across workspace history.
    sessionRef: text('session_ref'),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
    // FTS5 search handled via separate virtual table + triggers
  },
  (table) => [
    index('idx_messages_channel_time').on(table.channelId, table.id),
    index('idx_messages_thread').on(table.threadId, table.id),
    index('idx_messages_workspace').on(table.workspaceId, table.id),
    index('idx_messages_workspace_session').on(
      table.workspaceId,
      table.sessionRef,
      sql`length(${table.id})`,
      table.id,
    ),
  ],
);

// Durable, payload-free evidence that a session_ref existed in a workspace.
// Message retention may remove every matching message; this ledger deliberately
// survives that pruning so the resolver can report aged_out instead of guessing
// that an empty live-message query means "no conversation".
export const messageSessions = sqliteTable(
  'message_sessions',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionRef: text('session_ref').notNull(),
    firstMessageAt: integer('first_message_at', { mode: 'timestamp' }).notNull(),
    lastMessageAt: integer('last_message_at', { mode: 'timestamp' }).notNull(),
    startIsKnown: integer('start_is_known', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.sessionRef] }),
    index('idx_message_sessions_workspace_last').on(table.workspaceId, table.lastMessageAt),
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
    index('idx_dm_conversations_channel').on(table.channelId),
  ],
);

// ============================================
// 1:1 DM Conversation Reservations
// ============================================
export const dmConversationReservations = sqliteTable(
  'dm_conversation_reservations',
  {
    conversationId: text('conversation_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    participantOneId: text('participant_one_id').notNull(),
    participantTwoId: text('participant_two_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    check(
      'dm_conversation_reservations_sorted_pair_check',
      sql`${table.participantOneId} <= ${table.participantTwoId}`,
    ),
    uniqueIndex('dm_conversation_reservations_pair_unique').on(
      table.workspaceId,
      table.participantOneId,
      table.participantTwoId,
    ),
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
    // Persist the exact lifetime of the issued PUT capability. Workspace
    // deletion keeps a cleanup tombstone through this deadline so a late PUT
    // cannot permanently recreate an object after the first delete attempt.
    uploadExpiresAt: integer('upload_expires_at', { mode: 'timestamp' }),
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('idx_files_workspace').on(table.workspaceId, table.createdAt),
    index('idx_files_uploader').on(table.uploadedBy),
  ],
);

// ============================================
// File Cleanup Outbox
// ============================================
/**
 * Durable object-deletion tombstones created by a trigger whenever a file row
 * is physically removed. There is deliberately no workspace foreign key: the
 * row must survive the workspace cascade until external storage confirms the
 * object is gone after every issued upload capability has expired.
 */
export const fileCleanupQueue = sqliteTable(
  'file_cleanup_queue',
  {
    storageKey: text('storage_key').primaryKey(),
    deleteAfter: integer('delete_after', { mode: 'timestamp' }).notNull(),
    processAfter: integer('process_after', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index('idx_file_cleanup_due').on(table.processAfter, table.storageKey)],
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
    tokenHash: text('token_hash'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex('webhooks_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_webhooks_workspace').on(table.workspaceId),
    index('idx_webhooks_token').on(table.tokenHash),
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
    headers: text('headers', { mode: 'json' }).$type<Record<string, string>>(),
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
      .references(() => agents.id, { onDelete: 'cascade' }),
    handlerNodeId: text('handler_node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    // The provider (within handlerNodeId) that registered this action; dispatch
    // resolves capability -> provider -> socket through it. Null for agent-hosted
    // actions.
    handlerProvider: text('handler_provider'),
    // A node-scoped action may claim the workspace-global name so it resolves
    // through `POST /v1/actions/:name/invoke`. At most one global alias per name.
    isGlobal: integer('is_global', { mode: 'boolean' }).notNull().default(false),
    // When true, an invoke whose provider is offline queues instead of failing
    // fast (the per-provider offline queue).
    queue: integer('queue', { mode: 'boolean' }).notNull().default(false),
    inputSchema: text('input_schema', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    outputSchema: text('output_schema', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
    availableTo: text('available_to', { mode: 'json' }).$type<string[]>(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    // Node-scoped uniqueness: two nodes may both define `run-etl`. SQLite treats
    // NULL handlerNodeId (agent-hosted) rows as distinct here, so agent-hosted
    // uniqueness is enforced by the partial index below.
    uniqueIndex('actions_workspace_node_name_unique').on(table.workspaceId, table.handlerNodeId, table.name),
    // Agent-hosted actions (no node) keep one action per workspace name.
    uniqueIndex('actions_workspace_agent_name_unique').on(table.workspaceId, table.name).where(sql`${table.handlerNodeId} IS NULL`),
    // At most one node action may claim a given workspace-global alias.
    uniqueIndex('actions_workspace_global_name_unique').on(table.workspaceId, table.name).where(sql`${table.isGlobal} = 1`),
    index('idx_actions_workspace').on(table.workspaceId),
    index('idx_actions_handler').on(table.handlerAgentId),
    index('idx_actions_node_handler').on(table.handlerNodeId),
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
    // Immutable response snapshots for idempotent replay. Deliberately not
    // foreign keys: a later handler release/deletion or routing move must not
    // rewrite the 201 acknowledgement for the invocation already dispatched.
    handlerAgentId: text('handler_agent_id'),
    handlerNodeId: text('handler_node_id'),
    input: text('input', { mode: 'json' }).default({}),
    output: text('output', { mode: 'json' }),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    dispatchedNodeId: text('dispatched_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    dispatchedAt: integer('dispatched_at', { mode: 'timestamp' }),
    spawnReservedAt: integer('spawn_reserved_at', { mode: 'timestamp' }),
    attemptedNodeIds: text('attempted_node_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    // Provider connection that received the current node dispatch. Inventory is
    // provider-scoped, so node_id alone is insufficient for reconciliation.
    dispatchedProvider: text('dispatched_provider'),
    retryAfterAt: integer('retry_after_at', { mode: 'timestamp' }),
    // When the TTL sweep first observed the handler's connection unreachable;
    // cleared when connectivity recovers. Failure requires CONTINUOUS
    // unreachability for the TTL, giving handler restarts a real grace window.
    handlerUnreachableSince: integer('handler_unreachable_since', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_action_invocations_workspace').on(table.workspaceId, table.createdAt),
    index('idx_action_invocations_action').on(table.actionId, table.createdAt),
    index('idx_action_invocations_caller').on(table.callerId, table.createdAt),
    index('idx_action_invocations_dispatched_node').on(table.dispatchedNodeId, table.createdAt),
    index('idx_action_invocations_pending_workspace')
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// ============================================
// Fleet Triggers
// ============================================
export const triggers = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channel: text('channel'),
    pattern: text('pattern'),
    mention: integer('mention', { mode: 'boolean' }),
    actionName: text('action_name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_triggers_workspace').on(table.workspaceId),
    index('idx_triggers_enabled').on(table.workspaceId, table.enabled),
    index('idx_triggers_action').on(table.workspaceId, table.actionName),
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
    status: text('status').notNull().default('queued'),
    seq: integer('seq').notNull().default(0),
    locationType: text('location_type').notNull().default('self_connected'),
    locationNodeId: text('location_node_id').references((): AnySQLiteColumn => nodes.id, { onDelete: 'set null' }),
    routeNodeId: text('route_node_id').references((): AnySQLiteColumn => nodes.id, { onDelete: 'set null' }),
    routeNodeKind: text('route_node_kind'),
    routeNodeRole: text('route_node_role'),
    deliveryAdapter: text('delivery_adapter'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }),
    lastDispatchError: text('last_dispatch_error'),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
    ackedAt: integer('acked_at', { mode: 'timestamp' }),
    deadLetteredAt: integer('dead_lettered_at', { mode: 'timestamp' }),
    retryable: integer('retryable', { mode: 'boolean' }),
    availableAt: integer('available_at', { mode: 'timestamp' }),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('deliveries_message_agent_unique').on(table.messageId, table.agentId),
    uniqueIndex('deliveries_agent_seq_unique').on(table.workspaceId, table.agentId, table.seq),
    index('idx_deliveries_agent').on(table.agentId, table.createdAt),
    index('idx_deliveries_agent_status_seq').on(table.workspaceId, table.agentId, table.status, table.seq),
    index('idx_deliveries_agent_active_created')
      .on(table.workspaceId, table.agentId, table.createdAt, table.id)
      .where(sql`${table.status} IN ('queued', 'delivered')`),
    index('idx_deliveries_expires').on(table.workspaceId, table.status, table.expiresAt),
    index('idx_deliveries_active_expiry')
      .on(table.expiresAt, table.id)
      .where(sql`${table.status} IN ('queued', 'delivered') AND ${table.expiresAt} IS NOT NULL`),
    index('idx_deliveries_retry_due')
      .on(table.status, table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.nextAttemptAt} IS NOT NULL`),
    index('idx_deliveries_status').on(table.workspaceId, table.status, table.createdAt),
    index('idx_deliveries_http_push_due').on(table.workspaceId, table.routeNodeKind, table.status, table.nextAttemptAt),
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

// ============================================
// Workspace Event Log (durable observer plane)
// ============================================
/**
 * Durable, per-workspace log of every workspace stream event. `seq` is a
 * per-workspace monotonic cursor (from 1) assigned at insert; `payload` stores
 * the exact `transformForClient(event)` JSON published to the stream (without
 * `seq` — the cursor lives in the column and is stamped onto the published
 * frame). No FK to `workspaces` by design: appends are best-effort and rows
 * are pruned by retention or explicitly removed with their workspace.
 */
export const workspaceEvents = sqliteTable(
  'workspace_events',
  {
    workspaceId: text('workspace_id').notNull(),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    channelId: text('channel_id'),
    payload: text('payload').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index('idx_workspace_events_created').on(table.workspaceId, table.createdAt),
  ],
);
