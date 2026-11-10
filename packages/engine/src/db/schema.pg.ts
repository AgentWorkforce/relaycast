/**
 * PostgreSQL translation of `schema.ts` (drizzle pg-core).
 *
 * This module is the source for `drizzle-kit generate` (see
 * `drizzle.pg.config.ts`) and for the Postgres adapter. It is NOT exported
 * from `schema.ts`, and the engine query surface still runs on SQLite only.
 * Every table, column, index, unique constraint, foreign key and CHECK in
 * `schema.ts` has a counterpart here with the same SQL name;
 * `schema.pg.test.ts` enforces that parity.
 *
 * All tables are in the default schema `public` of the service's own database.
 * The platform creates the database and owner/runtime roles; the generated migrations never emit
 * schema or role DDL (scripts/generate-pg-migrations.mjs refuses it).
 *
 * Type mapping rules:
 *
 * - Timestamps: SQLite stores epoch seconds in `integer(mode: 'timestamp')`.
 *   Here they are `bigint` epoch seconds through the `epochSeconds` custom type,
 *   which maps `Date` <-> seconds exactly like drizzle's SQLite timestamp mode,
 *   so the stored values and engine semantics are unchanged. The SQLite default
 *   `(unixepoch())` becomes `floor(extract(epoch from statement_timestamp()))`.
 * - Plain integers: `integer` (int4) only for small, bounded values (enums,
 *   levels, priorities, positions, retry/attempt counters, agent counts, test
 *   counts, HTTP statuses, minute/second intervals). Everything that can grow
 *   without bound - sequences, revisions, generations, high-water marks, byte
 *   and millisecond counters, usage totals - is `bigint` with `mode: 'number'`
 *   (values stay JS numbers, matching SQLite; the pool's int8 parser rejects
 *   anything beyond Number.MAX_SAFE_INTEGER instead of silently rounding).
 * - Booleans: SQLite `integer(mode: 'boolean')` becomes native `boolean`.
 * - JSON: `text(mode: 'json')` becomes `jsonb`, except the three replay
 *   snapshot columns (`direct_dm_idempotency.response`,
 *   `a2a_egress_context.response`, `a2a_inbound.response`) which are `json` so
 *   the stored document is returned byte-for-byte (jsonb normalises key order
 *   and whitespace). Plain `text` columns holding JSON strings (for example
 *   `workspace_events.payload`) stay `text`.
 * - Defaults: the column DEFAULTs of a fully migrated SQLite database, not
 *   schema.ts's `.default()` values. drizzle only uses `.default()` when
 *   generating migrations; inserts never apply it, and several SQLite
 *   migrations changed defaults or rewrote rows without rebuilding the table,
 *   so schema.ts and the migrated DDL disagree for agents.status,
 *   deliveries.status, nodes.kind, nodes.delivery_adapter and
 *   pending_events.max_attempts. schema.pg.test.ts compares defaults,
 *   nullability and CHECK bodies with a migrated SQLite database.
 * - CHECKs: every migrated SQLite CHECK is enforced. Domain checks Postgres
 *   enforces natively are not repeated: `start_is_known IN (0, 1)` is a
 *   `boolean NOT NULL` column here, and the workspaces usage/source domain
 *   checks are implied by workspaces_usage_classification_source_check.
 * - The workspaces.stripe_customer_id / stripe_subscription_id columns the
 *   SQLite migrations still carry are absent from schema.ts and intentionally
 *   absent here.
 * - `real` becomes `double precision`. schema.ts has no blob columns; any
 *   future blob maps to `bytea`.
 *
 * rowid: SQLite gives every table an implicit `rowid`, and the engine reads it
 * (workspace drain and rowid retention scan generic tables by rowid; DM
 * listing orders by `dm_conversations.rowid`; inbox paging and the FTS joins
 * key on `messages.rowid` / `agents.rowid` / `skills.rowid`). No table in
 * schema.ts has an integer primary key, so every table here gets an explicit
 * `rowid bigint generated always as identity` column with a unique index
 * `<table>_rowid_unique`. Like SQLite rowids it is monotonically assigned on
 * insert and never written by the application.
 */
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  doublePrecision,
  json,
  jsonb,
  customType,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FleetCapability } from '@relaycast/types';
import type {
  ObserverTokenFilters,
  TaskInvocationState,
  WorkspaceProvenanceRecord,
  WorkspaceRetentionSettings,
} from './schema.js';

export type {
  ObserverTokenFilters,
  TaskInvocationState,
  WorkspaceProvenanceRecord,
  WorkspaceRetentionSettings,
} from './schema.js';


/** Epoch seconds stored as bigint; `Date` in JS, like SQLite timestamp mode. */
export const epochSeconds = customType<{ data: Date; driverData: number | string }>({
  dataType() {
    return 'bigint';
  },
  toDriver(value: Date): number {
    return Math.floor(value.getTime() / 1000);
  },
  fromDriver(value: number | string): Date {
    return new Date(Number(value) * 1000);
  },
});

/** SQL default equivalent to SQLite `(unixepoch())`. */
const epochNow = sql`floor(extract(epoch from statement_timestamp()))::bigint`;

/**
 * `id COLLATE "C"`: index expression for (length(id), id) orderings, so the
 * Postgres index order matches SQLite's binary text order. Queries must use
 * the same `id COLLATE "C"` to be served by the index.
 */
const idCollateC = (id: AnyPgColumn) => sql`${id} COLLATE "C"`;

/**
 * `(task_state ->> 'deadline') COLLATE "C"`: the ISO-8601 task deadline
 * compared as binary text (chronological for toISOString() values). Queries
 * must use exactly this expression to be served by the deadline indexes.
 */
const taskDeadlineC = (taskState: AnyPgColumn) => sql`((${taskState} ->> 'deadline') COLLATE "C")`;

/** Explicit rowid column; see module header. */
const rowid = () => bigint('rowid', { mode: 'number' }).generatedAlwaysAsIdentity().notNull();

// ============================================
// Workspaces
// ============================================
export const workspaces = pgTable(
  'workspaces',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    apiKeyHash: text('api_key_hash').notNull().unique(),
    // Superseded key captured by rotateWorkspaceKey; authenticatable only
    // while previousApiKeyExpiresAt is in the future. Mirrors the agent-token
    // previous slot (migration 0035).
    previousApiKeyHash: text('previous_api_key_hash'),
    previousApiKeyExpiresAt: epochSeconds('previous_api_key_expires_at'),
    // Monotonic fence for out-of-band key writers so a stale control-plane
    // repair cannot overwrite a newer rotation (0073).
    apiKeyGeneration: bigint('api_key_generation', { mode: 'number' }).notNull().default(0),
    systemPrompt: text('system_prompt'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    retention: jsonb('retention').$type<WorkspaceRetentionSettings>(),
    // A non-null deadline is an explicit, immutable opt-in to whole-workspace
    // deletion. Persistent workspaces always leave this null.
    expiresAt: epochSeconds('expires_at'),
    provenance: jsonb('provenance').$type<WorkspaceProvenanceRecord>(),
    usageClassification: text('usage_classification').notNull().default('unknown'),
    classificationSource: text('classification_source').notNull().default('unclassified'),
    classificationReason: text('classification_reason'),
    classifiedAt: epochSeconds('classified_at'),
  },
  (table) => [
    uniqueIndex('workspaces_rowid_unique').on(table.rowid),
    index('idx_workspaces_expires_at').on(table.expiresAt),
    index('idx_workspaces_previous_api_key').on(table.previousApiKeyHash),
    // Present in the SQLite migrations (not declared in schema.ts).
    index('idx_workspaces_usage_classification').on(table.usageClassification, table.createdAt),
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
export const workspaceCreateIdempotency = pgTable(
  'workspace_create_idempotency',
  {
    rowid: rowid(),
    ownerScopeHash: text('owner_scope_hash').notNull(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    requestDigest: text('request_digest').notNull(),
    workspaceId: text('workspace_id').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    terminalizedAt: epochSeconds('terminalized_at'),
  },
  (table) => [
    uniqueIndex('workspace_create_idempotency_rowid_unique').on(table.rowid),
    primaryKey({ columns: [table.ownerScopeHash, table.idempotencyKeyHash] }),
    uniqueIndex('workspace_create_idempotency_workspace_unique').on(table.workspaceId),
  ],
);

/**
 * Legacy credentials replaced through `POST /v1/credentials/upgrade`. The
 * principal's hash column holds the `ar_` credential; the legacy one keeps
 * authenticating until `expiresAt`, and only while the principal still holds
 * `arHash`. `sealedCredential` lets a retry with the legacy credential get the
 * same `ar_` credential back.
 */
export const credentialUpgrades = pgTable(
  'credential_upgrades',
  {
    rowid: rowid(),
    legacyHash: text('legacy_hash').primaryKey(),
    kind: text('kind').notNull(),
    principalId: text('principal_id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    arHash: text('ar_hash').notNull(),
    /** The `ar_` credential, AES-GCM sealed under a key derived from the legacy credential. */
    sealedCredential: text('sealed_credential').notNull(),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    expiresAt: epochSeconds('expires_at').notNull(),
  },
  (table) => [
    uniqueIndex('credential_upgrades_rowid_unique').on(table.rowid),
    index('idx_credential_upgrades_workspace').on(table.workspaceId)],
);

// ============================================
// Agents
// ============================================
export const agents = pgTable(
  'agents',
  {
    rowid: rowid(),
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
    previousTokenExpiresAt: epochSeconds('previous_token_expires_at'),
    // Migrated SQLite default (0000), not schema.ts's; see "Defaults" above.
    status: text('status').notNull().default('online'),
    handle: text('handle'),
    persona: text('persona'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>(),
    locationType: text('location_type').notNull().default('self_connected'),
    locationNodeId: text('location_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    // The node provider whose connection registered this agent. `deliver` frames
    // route to that provider's socket. Defaults to the synthetic `default`
    // provider (the broker) for agents registered before the provider model.
    providerName: text('provider_name').notNull().default('default'),
    resumable: boolean('resumable').notNull().default(false),
    sessionRef: text('session_ref'),
    originNodeId: text('origin_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    deliveryAckSeq: bigint('delivery_ack_seq', { mode: 'number' }).notNull().default(0),
    // Durable allocation high-water. Unlike MAX(deliveries.seq), this survives
    // settled-delivery pruning and message-retention cascades.
    deliverySeq: bigint('delivery_seq', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    lastSeen: epochSeconds('last_seen').notNull().default(epochNow),
    // Conservative witness used to reconcile pre-0056 keyed status events.
    // Migration 0056 backfills historical rows from last_seen and its SQLite
    // trigger advances this value for every later status/liveness write.
    statusUpdatedAt: epochSeconds('status_updated_at'),
    // Only liveness transitions populate this; explicit status writes clear it.
    statusBeforeLivenessLoss: text('status_before_liveness_loss'),
    // Monotonic boundary copied from the hosting node's liveness generation.
    // Offline settlement uses this instead of second-resolution timestamps so
    // a same-second re-registration cannot be mistaken for pre-claim state.
    nodeLivenessRevision: bigint('node_liveness_revision', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    uniqueIndex('agents_rowid_unique').on(table.rowid),
    uniqueIndex('agents_workspace_name_unique').on(table.workspaceId, table.name),
    // A UNIQUE constraint (not just an index) so it exists before the composite
    // foreign keys drizzle-kit emits ahead of CREATE INDEX statements.
    unique('agents_workspace_id_unique').on(table.workspaceId, table.id),
    index('idx_agents_workspace').on(table.workspaceId),
    index('idx_agents_roster')
      .on(table.workspaceId, table.status, table.lastSeen)
      .where(sql`${table.status} <> 'released'`),
    index('idx_agents_location_node_fk').on(table.locationNodeId)
      .where(sql`${table.locationNodeId} IS NOT NULL`),
    index('idx_agents_location_node_liveness_revision')
      .on(table.workspaceId, table.locationNodeId, table.nodeLivenessRevision)
      .where(sql`${table.locationType} = 'via_node' AND ${table.locationNodeId} IS NOT NULL AND ${table.status} NOT IN ('offline', 'released')`),
    index('idx_agents_origin_node_fk').on(table.originNodeId)
      .where(sql`${table.originNodeId} IS NOT NULL`),
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
export const agentRecoveryCredentials = pgTable(
  'agent_recovery_credentials',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    proofKind: text('proof_kind').notNull(),
    verifierHash: text('verifier_hash').notNull(),
    workUnitId: text('work_unit_id'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('agent_recovery_credentials_rowid_unique').on(table.rowid),
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
export const agentIdentityAudit = pgTable(
  'agent_identity_audit',
  {
    rowid: rowid(),
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
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('agent_identity_audit_rowid_unique').on(table.rowid),
    index('idx_agent_identity_audit_workspace').on(table.workspaceId, table.createdAt),
    index('idx_agent_identity_audit_agent').on(table.workspaceId, table.agentId, table.createdAt),
  ],
);

// ============================================
// Nodes
// ============================================
export const nodes = pgTable(
  'nodes',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    // A successful idempotent rotation retains only the superseded token hash
    // and request binding for a bounded recovery window. This lets a caller
    // recover the replacement after a lost 201 without making the workspace
    // key sufficient to rotate an established node. A keyed first enrollment
    // retains the same binding and window with no superseded hash (a rotation
    // from nothing), so its minted token is recoverable by the same key.
    previousTokenHash: text('previous_token_hash'),
    previousTokenExpiresAt: epochSeconds('previous_token_expires_at'),
    rotationIdempotencyKeyHash: text('rotation_idempotency_key_hash'),
    rotationRequestDigest: text('rotation_request_digest'),
    // Physical machine grouping in fleet views and a placement input; never a
    // capability scope. Set at enrollment when the caller supplies it, and by a
    // provider on register; null when neither reports one.
    machineId: text('machine_id'),
    // Migrated SQLite defaults (0021/0025 rewrote rows, not the defaults);
    // see "Defaults" in the module header.
    kind: text('kind').notNull().default('fleet_ws'),
    role: text('role').notNull().default('broker'),
    deliveryAdapter: text('delivery_adapter').notNull().default('fleet.ws.v1'),
    deliveryConfig: jsonb('delivery_config').$type<Record<string, unknown>>(),
    capabilities: jsonb('capabilities').$type<FleetCapability[]>().notNull().default([]),
    // Zero is the fleet-wide sentinel for unlimited capacity.
    maxAgents: integer('max_agents').notNull().default(0),
    activeAgents: integer('active_agents').notNull().default(0),
    reservedAgents: integer('reserved_agents').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    version: text('version').notNull().default('unknown'),
    status: text('status').notNull().default('offline'),
    handlersLive: boolean('handlers_live').notNull().default(false),
    load: doublePrecision('load').notNull().default(0),
    loadReported: boolean('load_reported').notNull().default(false),
    lastHeartbeatAt: epochSeconds('last_heartbeat_at'),
    // Written ONLY by an arriving heartbeat frame — never by registration or
    // disconnect cleanup, both of which write lastHeartbeatAt. Cleared when
    // enrollment re-issues this row's token. This is the only column that means
    // "this node proved it was alive", and the machine_id reuse gate reads it.
    provenLiveAt: epochSeconds('proven_live_at'),
    // Advanced by every node liveness write and explicitly by an offline
    // claim. Child provider/agent/invocation rows are stamped relative to this
    // generation so the asynchronous settle tail has a precise boundary.
    livenessRevision: bigint('liveness_revision', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('nodes_rowid_unique').on(table.rowid),
    uniqueIndex('nodes_workspace_name_unique').on(table.workspaceId, table.name),
    // A UNIQUE constraint (not just an index) so it exists before the composite
    // foreign keys drizzle-kit emits ahead of CREATE INDEX statements.
    unique('nodes_workspace_id_unique').on(table.workspaceId, table.id),
    index('idx_nodes_workspace').on(table.workspaceId),
    index('idx_nodes_token').on(table.tokenHash),
    index('idx_nodes_status').on(table.workspaceId, table.status),
    index('idx_nodes_status_heartbeat').on(table.workspaceId, table.status, table.lastHeartbeatAt),
    index('idx_nodes_workspace_machine').on(table.workspaceId, table.machineId),
    index('idx_nodes_workspace_machine_proven').on(table.workspaceId, table.machineId, table.provenLiveAt),
    index('idx_nodes_workspace_previous_token').on(table.workspaceId, table.previousTokenHash),
    // Present in the SQLite migrations (not declared in schema.ts).
    index('idx_nodes_online_liveness')
      .on(table.lastHeartbeatAt, table.workspaceId, table.id)
      .where(sql`${table.status} = 'online'`),
    index('idx_nodes_context_reachable')
      .on(table.workspaceId, table.id)
      .where(
        sql`${table.kind} = 'http_push' OR (${table.kind} IN ('ws', 'fleet_ws', 'direct_ws') AND ${table.status} <> 'offline')`,
      ),
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
export const nodeProviders = pgTable(
  'node_providers',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    nodeId: text('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instanceId: text('instance_id').notNull(),
    capabilities: jsonb('capabilities').$type<FleetCapability[]>().notNull().default([]),
    // Zero is the fleet-wide sentinel for unlimited provider capacity.
    maxAgents: integer('max_agents').notNull().default(0),
    activeAgents: integer('active_agents').notNull().default(0),
    load: doublePrecision('load').notNull().default(0),
    loadReported: boolean('load_reported').notNull().default(false),
    handlersLive: boolean('handlers_live').notNull().default(false),
    status: text('status').notNull().default('offline'),
    version: text('version').notNull().default('unknown'),
    lastHeartbeatAt: epochSeconds('last_heartbeat_at'),
    livenessRevision: bigint('liveness_revision', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('node_providers_rowid_unique').on(table.rowid),
    uniqueIndex('node_providers_node_name_unique').on(table.workspaceId, table.nodeId, table.name),
    index('idx_node_providers_node').on(table.workspaceId, table.nodeId),
    index('idx_node_providers_liveness_revision')
      .on(table.workspaceId, table.nodeId, table.livenessRevision),
    index('idx_node_providers_node_fk').on(table.nodeId),
  ],
);

// ============================================
// Observer Tokens
// ============================================
export const observerTokens = pgTable(
  'observer_tokens',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // schema.ts also marks this column .unique(); that resolves to the same
    // name as the explicit uniqueIndex below, so only the index is declared.
    tokenHash: text('token_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    filters: jsonb('filters').$type<ObserverTokenFilters>().notNull().default({}),
    status: text('status').notNull().default('active'),
    expiresAt: epochSeconds('expires_at'),
    createdBy: text('created_by'),
    createdByType: text('created_by_type').notNull().default('workspace'),
    lastUsedAt: epochSeconds('last_used_at'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at'),
    revokedAt: epochSeconds('revoked_at'),
  },
  (table) => [
    uniqueIndex('observer_tokens_rowid_unique').on(table.rowid),
    uniqueIndex('observer_tokens_workspace_name_unique').on(table.workspaceId, table.name),
    uniqueIndex('observer_tokens_token_hash_unique').on(table.tokenHash),
    index('idx_observer_tokens_workspace_status').on(table.workspaceId, table.status),
    index('idx_observer_tokens_expires_at').on(table.expiresAt),
  ],
);

// ============================================
// Agent Node Bindings
// ============================================
export const agentNodeBindings = pgTable(
  'agent_node_bindings',
  {
    rowid: rowid(),
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
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at'),
  },
  (table) => [
    uniqueIndex('agent_node_bindings_rowid_unique').on(table.rowid),
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
    index('idx_agent_node_bindings_node_fk').on(table.nodeId),
  ],
);

// ============================================
// A2A Agents
// ============================================
export const a2aAgents = pgTable(
  'a2a_agents',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    relayAgentId: text('relay_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // SQLite DDL default is the JSON text '{}'; jsonb default is the object.
    agentCard: jsonb('agent_card').notNull().default({}),
    externalUrl: text('external_url').notNull(),
    authScheme: text('auth_scheme'),
    authCredential: text('auth_credential'),
    status: text('status').notNull().default('active'),
    messagesSent: bigint('messages_sent', { mode: 'number' }).notNull().default(0),
    messagesRecv: bigint('messages_recv', { mode: 'number' }).notNull().default(0),
    lastHealth: epochSeconds('last_health'),
    healthFailures: integer('health_failures').notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('a2a_agents_rowid_unique').on(table.rowid),
    index('idx_a2a_agents_workspace').on(table.workspaceId),
    uniqueIndex('idx_a2a_agents_relay_agent').on(table.relayAgentId),
  ],
);

// ============================================
// Directory Agents
// ============================================
export const directoryAgents = pgTable(
  'directory_agents',
  {
    rowid: rowid(),
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
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('active'),
    ratingSum: bigint('rating_sum', { mode: 'number' }).notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('directory_agents_rowid_unique').on(table.rowid),
    uniqueIndex('directory_agents_workspace_slug_unique').on(table.workspaceId, table.slug),
    index('idx_directory_agents_workspace').on(table.workspaceId, table.createdAt),
    index('idx_directory_agents_source_agent').on(table.sourceAgentId),
    index('idx_directory_agents_status').on(table.workspaceId, table.status),
  ],
);

// ============================================
// Directory Skills
// ============================================
export const directorySkills = pgTable(
  'directory_skills',
  {
    rowid: rowid(),
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
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    position: integer('position').notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('directory_skills_rowid_unique').on(table.rowid),
    index('idx_directory_skills_agent').on(table.directoryAgentId, table.position),
    index('idx_directory_skills_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Directory Ratings
// ============================================
export const directoryRatings = pgTable(
  'directory_ratings',
  {
    rowid: rowid(),
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
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('directory_ratings_rowid_unique').on(table.rowid),
    uniqueIndex('directory_ratings_agent_rater_unique').on(table.directoryAgentId, table.raterAgentId),
    index('idx_directory_ratings_workspace').on(table.workspaceId, table.createdAt),
    index('idx_directory_ratings_rater').on(table.raterAgentId),
    index('idx_directory_ratings_directory_agent').on(table.directoryAgentId, table.createdAt),
  ],
);

// ============================================
// Smart Routing
// ============================================
export const routingConfigs = pgTable(
  'routing_configs',
  {
    rowid: rowid(),
    workspaceId: text('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    weights: jsonb('weights').notNull().default({}),
    circuitBreakerThreshold: integer('circuit_breaker_threshold').notNull().default(3),
    circuitBreakerCooldownSeconds: integer('circuit_breaker_cooldown_seconds').notNull().default(300),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('routing_configs_rowid_unique').on(table.rowid),
    index('idx_routing_configs_updated_at').on(table.updatedAt),
  ],
);

export const routingFailures = pgTable(
  'routing_failures',
  {
    rowid: rowid(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    totalFailures: bigint('total_failures', { mode: 'number' }).notNull().default(0),
    totalSuccesses: bigint('total_successes', { mode: 'number' }).notNull().default(0),
    lastFailureAt: epochSeconds('last_failure_at'),
    lastSuccessAt: epochSeconds('last_success_at'),
    circuitOpenUntil: epochSeconds('circuit_open_until'),
    lastError: text('last_error'),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('routing_failures_rowid_unique').on(table.rowid),
    primaryKey({ columns: [table.workspaceId, table.agentId] }),
    index('idx_routing_failures_workspace').on(table.workspaceId, table.updatedAt),
    index('idx_routing_failures_agent').on(table.agentId),
    index('idx_routing_failures_circuit').on(table.workspaceId, table.circuitOpenUntil),
  ],
);

// ============================================
// Certifications
// ============================================
export const certifications = pgTable(
  'certifications',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentUrl: text('agent_url').notNull(),
    level: integer('level').notNull(),
    source: text('source').notNull().default('manual'),
    status: text('status').notNull().default('pending'),
    passed: boolean('passed').notNull().default(false),
    passedTests: integer('passed_tests').notNull().default(0),
    totalTests: integer('total_tests').notNull().default(0),
    monitorEnabled: boolean('monitor_enabled').notNull().default(false),
    monitorIntervalMinutes: integer('monitor_interval_minutes').notNull().default(60),
    lastRunAt: epochSeconds('last_run_at'),
    results: jsonb('results').default([]),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('certifications_rowid_unique').on(table.rowid),
    index('idx_certifications_workspace').on(table.workspaceId, table.createdAt),
    index('idx_certifications_agent_url').on(table.agentUrl),
    index('idx_certifications_monitor_enabled').on(table.monitorEnabled, table.updatedAt),
  ],
);

// ============================================
// Channels
// ============================================
export const channels = pgTable(
  'channels',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelType: integer('channel_type').notNull().default(0),
    topic: text('topic'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdBy: text('created_by').references(() => agents.id),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    isArchived: boolean('is_archived').notNull().default(false),
  },
  (table) => [
    uniqueIndex('channels_rowid_unique').on(table.rowid),
    uniqueIndex('channels_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_channels_workspace').on(table.workspaceId),
    index('idx_channels_creator').on(table.createdBy),
  ],
);

// ============================================
// Channel Members
// ============================================
export const channelMembers = pgTable(
  'channel_members',
  {
    rowid: rowid(),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: epochSeconds('joined_at').notNull().default(epochNow),
    lastReadId: text('last_read_id'),
    isMuted: boolean('is_muted').notNull().default(false),
  },
  (table) => [
    uniqueIndex('channel_members_rowid_unique').on(table.rowid),
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
    rowid: rowid(),
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
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    // Denormalized from public metadata.session_ref at write time. Keeping the
    // join key in a real column makes replay lookup bounded and index-backed;
    // callers must never scan JSON metadata across workspace history.
    sessionRef: text('session_ref'),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at'),
    // FTS5 search handled via separate virtual table + triggers
  },
  (table) => [
    uniqueIndex('messages_rowid_unique').on(table.rowid),
    index('idx_messages_channel_time').on(table.channelId, table.id),
    // (length(id), id) orderings: `id` is indexed COLLATE "C" so the index
    // order is SQLite's binary text order. Queries must order/compare with
    // the same expression - `length(id), id COLLATE "C"` - to use it.
    index('idx_messages_retention').on(sql`length(${table.id})`, idCollateC(table.id)),
    index('idx_messages_thread').on(table.threadId, table.id),
    index('idx_messages_workspace').on(table.workspaceId, table.id),
    index('idx_messages_workspace_length_id').on(
      table.workspaceId,
      sql`length(${table.id})`,
      idCollateC(table.id),
    ),
    index('idx_messages_agent').on(table.agentId),
    index('idx_messages_workspace_session').on(
      table.workspaceId,
      table.sessionRef,
      sql`length(${table.id})`,
      idCollateC(table.id),
    ),
  ],
);

/**
 * Atomic DM idempotency claims. Cloudflare KV remains the fast replay cache,
 * while this D1 row is the concurrency authority across direct and A2A
 * routing: the claim and message share one admission batch. The response
 * snapshot is retained for the 24-hour claim lifetime so a replay returns the
 * exact public receipt even if mutable message context changes meanwhile.
 */
export const directDmIdempotency = pgTable(
  'direct_dm_idempotency',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    response: jsonb('response').$type<Record<string, unknown>>().notNull(),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('direct_dm_idempotency_rowid_unique').on(table.rowid),
    index('idx_direct_dm_idempotency_workspace_created').on(table.workspaceId, table.createdAt),
    index('idx_direct_dm_idempotency_retention').on(table.createdAt, table.id),
  ],
);

// Durable, payload-free evidence that a session_ref existed in a workspace.
// Message retention may remove every matching message; this ledger deliberately
// survives that pruning so the resolver can report aged_out instead of guessing
// that an empty live-message query means "no conversation".
export const messageSessions = pgTable(
  'message_sessions',
  {
    rowid: rowid(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionRef: text('session_ref').notNull(),
    firstMessageAt: epochSeconds('first_message_at').notNull(),
    lastMessageAt: epochSeconds('last_message_at').notNull(),
    startIsKnown: boolean('start_is_known').notNull().default(true),
  },
  (table) => [
    uniqueIndex('message_sessions_rowid_unique').on(table.rowid),
    primaryKey({ columns: [table.workspaceId, table.sessionRef] }),
    index('idx_message_sessions_workspace_last').on(table.workspaceId, table.lastMessageAt),
  ],
);

// ============================================
// Message Logs
// ============================================
export const messageLogs = pgTable(
  'message_logs',
  {
    rowid: rowid(),
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
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    attachmentCount: integer('attachment_count').notNull().default(0),
    mentionCount: integer('mention_count').notNull().default(0),
    latencyMs: bigint('latency_ms', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('message_logs_rowid_unique').on(table.rowid),
    uniqueIndex('message_logs_message_unique').on(table.messageId),
    index('idx_message_logs_workspace_time').on(table.workspaceId, table.id),
    // See idx_messages_retention: `length(id), id COLLATE "C"`.
    index('idx_message_logs_retention').on(sql`length(${table.id})`, idCollateC(table.id)),
    index('idx_message_logs_agent_time').on(table.agentId, table.id),
    index('idx_message_logs_channel_time').on(table.channelId, table.id),
    index('idx_message_logs_conversation_time').on(table.conversationId, table.id),
  ],
);

// ============================================
// Reactions
// ============================================
export const reactions = pgTable(
  'reactions',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('reactions_rowid_unique').on(table.rowid),
    uniqueIndex('reactions_message_agent_emoji_unique').on(
      table.messageId,
      table.agentId,
      table.emoji,
    ),
    index('idx_reactions_message').on(table.messageId),
    index('idx_reactions_agent').on(table.agentId),
  ],
);

// ============================================
// DM Conversations
// ============================================
export const dmConversations = pgTable(
  'dm_conversations',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    dmType: text('dm_type').notNull().default('1:1'),
    name: text('name'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('dm_conversations_rowid_unique').on(table.rowid),
    index('idx_dm_conversations_workspace').on(table.workspaceId),
    index('idx_dm_conversations_channel').on(table.channelId),
  ],
);

// ============================================
// 1:1 DM Conversation Reservations
// ============================================
export const dmConversationReservations = pgTable(
  'dm_conversation_reservations',
  {
    rowid: rowid(),
    conversationId: text('conversation_id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    participantOneId: text('participant_one_id').notNull(),
    participantTwoId: text('participant_two_id').notNull(),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('dm_conversation_reservations_rowid_unique').on(table.rowid),
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
export const dmParticipants = pgTable(
  'dm_participants',
  {
    rowid: rowid(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => dmConversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    joinedAt: epochSeconds('joined_at').notNull().default(epochNow),
    leftAt: epochSeconds('left_at'),
    // Inbox unread for this participant. Channel cursors live on
    // channel_members; a DM has no channel membership row.
    lastReadId: text('last_read_id'),
  },
  (table) => [
    uniqueIndex('dm_participants_rowid_unique').on(table.rowid),
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
    rowid: rowid(),
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
    // Persist the exact lifetime of the issued PUT capability. Workspace
    // deletion keeps a cleanup tombstone through this deadline so a late PUT
    // cannot permanently recreate an object after the first delete attempt.
    uploadExpiresAt: epochSeconds('upload_expires_at'),
    status: text('status').notNull().default('pending'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('files_rowid_unique').on(table.rowid),
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
export const fileCleanupQueue = pgTable(
  'file_cleanup_queue',
  {
    rowid: rowid(),
    storageKey: text('storage_key').primaryKey(),
    deleteAfter: epochSeconds('delete_after').notNull(),
    processAfter: epochSeconds('process_after').notNull().default(epochNow),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('file_cleanup_queue_rowid_unique').on(table.rowid),
    index('idx_file_cleanup_due').on(table.processAfter, table.storageKey)],
);

// ============================================
// Message Attachments (junction table)
// ============================================
export const messageAttachments = pgTable(
  'message_attachments',
  {
    rowid: rowid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
  },
  (table) => [
    uniqueIndex('message_attachments_rowid_unique').on(table.rowid),
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
    rowid: rowid(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    readAt: epochSeconds('read_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('read_receipts_rowid_unique').on(table.rowid),
    primaryKey({ columns: [table.messageId, table.agentId] }),
    uniqueIndex('idx_read_receipts_retention').on(table.messageId, table.agentId),
    index('idx_read_receipts_agent').on(table.agentId, table.readAt),
  ],
);

// ============================================
// Usage Records
// ============================================
export const usageRecords = pgTable(
  'usage_records',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    periodStart: epochSeconds('period_start').notNull(),
    periodEnd: epochSeconds('period_end').notNull(),
    messagesSent: bigint('messages_sent', { mode: 'number' }).notNull().default(0),
    apiCalls: bigint('api_calls', { mode: 'number' }).notNull().default(0),
    filesUploaded: bigint('files_uploaded', { mode: 'number' }).notNull().default(0),
    fileBytes: bigint('file_bytes', { mode: 'number' }).notNull().default(0),
    wsMinutes: bigint('ws_minutes', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('usage_records_rowid_unique').on(table.rowid),
    index('idx_usage_workspace_period').on(table.workspaceId, table.periodStart),
  ],
);

// ============================================
// Inbound Webhooks
// ============================================
export const webhooks = pgTable(
  'webhooks',
  {
    rowid: rowid(),
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
    isActive: boolean('is_active').notNull().default(true),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('webhooks_rowid_unique').on(table.rowid),
    uniqueIndex('webhooks_workspace_name_unique').on(table.workspaceId, table.name),
    index('idx_webhooks_workspace').on(table.workspaceId),
    index('idx_webhooks_creator').on(table.createdBy),
    index('idx_webhooks_token').on(table.tokenHash),
  ],
);

// ============================================
// Outbound Event Subscriptions
// ============================================
export const eventSubscriptions = pgTable(
  'event_subscriptions',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    events: jsonb('events').notNull().$type<string[]>(),
    filter: jsonb('filter').$type<{ channel?: string; mentions?: string }>(),
    url: text('url').notNull(),
    headers: jsonb('headers').$type<Record<string, string>>(),
    secret: text('secret'),
    signatureScheme: text('signature_scheme')
      .$type<'legacy' | 'standard-webhooks'>()
      .notNull()
      .default('legacy'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('event_subscriptions_rowid_unique').on(table.rowid),
    index('idx_event_subscriptions_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Actions (typed agent capabilities)
// ============================================
export const actions = pgTable(
  'actions',
  {
    rowid: rowid(),
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
    isGlobal: boolean('is_global').notNull().default(false),
    // When true, an invoke whose provider is offline queues instead of failing
    // fast (the per-provider offline queue).
    queue: boolean('queue').notNull().default(false),
    executionMode: text('execution_mode').$type<'short' | 'task'>().notNull().default('short'),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().default({}),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().default({}),
    availableTo: jsonb('available_to').$type<string[]>(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('actions_rowid_unique').on(table.rowid),
    // Node-scoped uniqueness: two nodes may both define `run-etl`. SQLite treats
    // NULL handlerNodeId (agent-hosted) rows as distinct here, so agent-hosted
    // uniqueness is enforced by the partial index below.
    uniqueIndex('actions_workspace_node_name_unique').on(table.workspaceId, table.handlerNodeId, table.name),
    // Agent-hosted actions (no node) keep one action per workspace name.
    uniqueIndex('actions_workspace_agent_name_unique').on(table.workspaceId, table.name).where(sql`${table.handlerNodeId} IS NULL`),
    // At most one node action may claim a given workspace-global alias.
    uniqueIndex('actions_workspace_global_name_unique').on(table.workspaceId, table.name).where(sql`${table.isGlobal} = true`),
    index('idx_actions_workspace').on(table.workspaceId),
    index('idx_actions_handler').on(table.handlerAgentId),
    index('idx_actions_node_handler').on(table.handlerNodeId),
  ],
);

// ============================================
// Action Invocations (audit log)
// ============================================
export const actionInvocations = pgTable(
  'action_invocations',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actionId: text('action_id').references(() => actions.id, { onDelete: 'set null' }),
    actionName: text('action_name').notNull(),
    // Immutable invocation provenance. action_id is a mutable FK that becomes
    // null when a materialized provider action is pruned, so it cannot safely
    // distinguish built-in lifecycle work from a user action with the same name.
    invocationOrigin: text('invocation_origin')
      .$type<'legacy_unknown' | 'registered_action' | 'builtin'>()
      .notNull()
      .default('legacy_unknown'),
    callerId: text('caller_id').references(() => agents.id, { onDelete: 'set null' }),
    callerName: text('caller_name'),
    // Immutable response snapshots for idempotent replay. Deliberately not
    // foreign keys: a later handler release/deletion or routing move must not
    // rewrite the 201 acknowledgement for the invocation already dispatched.
    handlerAgentId: text('handler_agent_id'),
    handlerNodeId: text('handler_node_id'),
    // Ownership token for a strict builtin spawn that is durably placed but
    // has definitely not crossed the provider send boundary. A retry may
    // claim only this exact token; the dispatch claim clears it before I/O.
    spawnPlacementToken: text('spawn_placement_token'),
    input: jsonb('input').default({}),
    taskState: jsonb('task_state').$type<TaskInvocationState>(),
    output: jsonb('output'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    dispatchedNodeId: text('dispatched_node_id').references(() => nodes.id, { onDelete: 'set null' }),
    dispatchedAt: epochSeconds('dispatched_at'),
    // Generation of the node liveness epoch that accepted this dispatch.
    // A lost-node settle only reschedules attempts older than its claim.
    nodeLivenessRevision: bigint('node_liveness_revision', { mode: 'number' }).notNull().default(0),
    // Dispatch-attempt generation accepted atomically by the socket owner.
    // Unlike action_id, this survives capability pruning without granting a
    // later retry generation the previous attempt's acceptance.
    providerAcceptedAttempt: integer('provider_accepted_attempt'),
    spawnReservedAt: epochSeconds('spawn_reserved_at'),
    attemptedNodeIds: jsonb('attempted_node_ids').$type<string[]>().notNull().default([]),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    // Provider connection that received the current node dispatch. Inventory is
    // provider-scoped, so node_id alone is insufficient for reconciliation.
    dispatchedProvider: text('dispatched_provider'),
    retryAfterAt: epochSeconds('retry_after_at'),
    // When the TTL sweep first observed the handler's connection unreachable;
    // cleared when connectivity recovers. Failure requires CONTINUOUS
    // unreachability for the TTL, giving handler restarts a real grace window.
    handlerUnreachableSince: epochSeconds('handler_unreachable_since'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    completedAt: epochSeconds('completed_at'),
  },
  (table) => [
    uniqueIndex('action_invocations_rowid_unique').on(table.rowid),
    index('idx_action_invocations_workspace').on(table.workspaceId, table.createdAt),
    index('idx_action_invocations_action').on(table.actionId, table.createdAt),
    index('idx_action_invocations_caller').on(table.callerId, table.createdAt),
    index('idx_action_invocations_dispatched_node').on(table.dispatchedNodeId, table.createdAt),
    index('idx_action_invocations_dispatched_node_liveness_revision')
      .on(table.workspaceId, table.dispatchedNodeId, table.nodeLivenessRevision)
      .where(sql`${table.dispatchedNodeId} IS NOT NULL AND ${table.status} IN ('pending', 'dispatched', 'invoked')`),
    index('idx_action_invocations_pending_workspace')
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    // Present in the SQLite migrations (not declared in schema.ts).
    //
    // Deadline indexes: task_state.deadline is an ISO-8601 UTC string
    // (`Date#toISOString()`, src/engine/taskInvocation.ts) and the engine
    // compares it as text against another toISOString() value, which is
    // chronological only under binary ordering. json_extract(task_state,
    // '$.deadline') therefore becomes `(task_state ->> 'deadline') COLLATE "C"`
    // and queries must use exactly that expression, e.g.
    //   ("task_state" ->> 'deadline') COLLATE "C" <= $1
    // A numeric cast (::bigint) is wrong here: it would raise 22P02 on every
    // insert of a task_state, because the deadline is not a number.
    index('idx_action_invocations_spawn_canceled').on(table.workspaceId, table.dispatchedNodeId),
    index('idx_action_invocations_status_dispatched').on(table.status, table.dispatchedAt),
    index('idx_action_invocations_status_retry_after').on(table.status, table.retryAfterAt),
    index('idx_action_invocations_status_task_deadline')
      .on(table.status, taskDeadlineC(table.taskState))
      .where(sql`${table.taskState} IS NOT NULL`),
    index('idx_action_invocations_task_deadline')
      .on(taskDeadlineC(table.taskState))
      .where(sql`${table.taskState} IS NOT NULL AND ${table.status} IN ('pending', 'dispatched', 'running')`),
    check(
      'action_invocations_invocation_origin_check',
      sql`${table.invocationOrigin} IN ('legacy_unknown', 'registered_action', 'builtin')`,
    ),
  ],
);

// ============================================
// Fleet Triggers
// ============================================
export const triggers = pgTable(
  'triggers',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channel: text('channel'),
    pattern: text('pattern'),
    mention: boolean('mention'),
    actionName: text('action_name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastTriggeredAt: epochSeconds('last_triggered_at'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at'),
  },
  (table) => [
    uniqueIndex('triggers_rowid_unique').on(table.rowid),
    index('idx_triggers_workspace').on(table.workspaceId),
    index('idx_triggers_enabled').on(table.workspaceId, table.enabled),
    index('idx_triggers_action').on(table.workspaceId, table.actionName),
  ],
);

// ============================================
// Session Events (harness-emitted observations)
// ============================================
export const sessionEvents = pgTable(
  'session_events',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    // Optional stable identity for callers that may retry after losing the
    // response. NULL keeps the legacy append-only contract for unkeyed calls.
    idempotencyKeyHash: text('idempotency_key_hash'),
    requestDigest: text('request_digest'),
    sequence: bigint('sequence', { mode: 'number' }).notNull().default(0),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    // Durable completion marker for a `status.*` event's agent-row mutation.
    // NULL means "not yet applied" — set atomically with the `agents` row
    // write (see `applyStatusEventEffect`) so a crash between the durable
    // event insert and the status update leaves this NULL, letting a replay
    // finish the interrupted mutation instead of silently skipping it forever.
    statusAppliedAt: epochSeconds('status_applied_at'),
    // Migration 0056 marks keyed status events created before this marker
    // existed. Their old event insert and agent update were separate writes,
    // so replay reconciles only when the agent write-time witness proves the
    // row predates the event; otherwise it claims without clobbering state.
    statusLegacyPending: boolean('status_legacy_pending').notNull().default(false),
  },
  (table) => [
    uniqueIndex('session_events_rowid_unique').on(table.rowid),
    uniqueIndex('session_events_agent_sequence_unique').on(table.agentId, table.sequence),
    uniqueIndex('session_events_agent_idempotency_unique').on(table.workspaceId, table.agentId, table.idempotencyKeyHash),
    index('idx_session_events_agent').on(table.agentId, table.createdAt),
    index('idx_session_events_workspace').on(table.workspaceId, table.createdAt),
    index('idx_session_events_type').on(table.workspaceId, table.type, table.createdAt),
  ],
);

// ============================================
// Deliveries (per-recipient message delivery tracking)
// ============================================
export const deliveries = pgTable(
  'deliveries',
  {
    rowid: rowid(),
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
    deadline: epochSeconds('deadline'),
    // Migrated SQLite default (0000), not schema.ts's; see "Defaults" above.
    status: text('status').notNull().default('pending'),
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    locationType: text('location_type').notNull().default('self_connected'),
    locationNodeId: text('location_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    routeNodeId: text('route_node_id').references((): AnyPgColumn => nodes.id, { onDelete: 'set null' }),
    routeNodeKind: text('route_node_kind'),
    routeNodeRole: text('route_node_role'),
    deliveryAdapter: text('delivery_adapter'),
    dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
    nextAttemptAt: epochSeconds('next_attempt_at'),
    lastDispatchError: text('last_dispatch_error'),
    expiresAt: epochSeconds('expires_at'),
    deliveredAt: epochSeconds('delivered_at'),
    ackedAt: epochSeconds('acked_at'),
    deadLetteredAt: epochSeconds('dead_lettered_at'),
    retryable: boolean('retryable'),
    availableAt: epochSeconds('available_at'),
    error: text('error'),
    idempotencyKey: text('idempotency_key'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    updatedAt: epochSeconds('updated_at'),
  },
  (table) => [
    uniqueIndex('deliveries_rowid_unique').on(table.rowid),
    uniqueIndex('deliveries_message_agent_unique').on(table.messageId, table.agentId),
    index('idx_deliveries_location_node_fk').on(table.locationNodeId)
      .where(sql`${table.locationNodeId} IS NOT NULL`),
    index('idx_deliveries_route_node_fk').on(table.routeNodeId)
      .where(sql`${table.routeNodeId} IS NOT NULL`),
    index('idx_deliveries_active_location_node').on(table.locationNodeId)
      .where(sql`${table.status} IN ('queued', 'delivered') AND ${table.locationNodeId} IS NOT NULL`),
    uniqueIndex('idx_deliveries_id_lookup').on(table.id),
    uniqueIndex('deliveries_agent_seq_unique').on(table.workspaceId, table.agentId, table.seq),
    index('idx_deliveries_agent').on(table.agentId, table.createdAt),
    index('idx_deliveries_agent_status_seq').on(table.workspaceId, table.agentId, table.status, table.seq),
    index('idx_deliveries_agent_active_seq').on(table.workspaceId, table.agentId, table.seq)
      .where(sql`${table.status} IN ('queued', 'delivered')`),
    index('idx_deliveries_agent_active_expiry').on(table.workspaceId, table.agentId, table.expiresAt)
      .where(sql`${table.status} IN ('queued', 'delivered')`),
    index('idx_deliveries_settled_retention').on(table.createdAt, table.id)
      .where(sql`${table.status} IN ('acked', 'failed', 'dead_lettered')`),
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
    index('idx_deliveries_node_initial').on(table.createdAt, table.id)
      .where(sql`${table.status} = 'queued' AND ${table.routeNodeKind} IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND ${table.nextAttemptAt} IS NULL`),
    index('idx_deliveries_node_initial_workspace').on(table.workspaceId, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued' AND ${table.routeNodeKind} IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND ${table.nextAttemptAt} IS NULL`),
    index('idx_deliveries_node_retry').on(table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued' AND ${table.routeNodeKind} IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND ${table.nextAttemptAt} IS NOT NULL`),
    index('idx_deliveries_node_retry_workspace').on(table.workspaceId, table.nextAttemptAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'queued' AND ${table.routeNodeKind} IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND ${table.nextAttemptAt} IS NOT NULL`),
    index('idx_deliveries_status').on(table.workspaceId, table.status, table.createdAt),
    index('idx_deliveries_agent_status_created')
      .on(table.workspaceId, table.agentId, table.status, table.createdAt, table.id),
  ],
);

// ============================================
// Pending Events (durable event queue)
// ============================================
export const pendingEvents = pgTable(
  'pending_events',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    // Parent claims cover crashes and scheduling; per-subscriber retry limits
    // live on webhookDeliveries. Keep enough headroom that lease recovery
    // cannot exhaust the parent before a subscriber reaches its final attempt.
    // Settled parents remain for 24h delivery-health/replay retention.
    // Migrated SQLite default (0000): 5. The engine always writes this column
    // explicitly; see "Defaults" in the module header.
    maxAttempts: integer('max_attempts').notNull().default(5),
    webhookInitialized: boolean('webhook_initialized').notNull().default(false),
    lastError: text('last_error'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    processAfter: epochSeconds('process_after').notNull().default(epochNow),
    completedAt: epochSeconds('completed_at'),
  },
  (table) => [
    uniqueIndex('pending_events_rowid_unique').on(table.rowid),
    index('idx_pending_events_status').on(table.status, table.processAfter),
    index('idx_pending_events_settled_retention').on(table.status, table.completedAt, table.id),
    index('idx_pending_events_workspace').on(table.workspaceId),
  ],
);

// ============================================
// Per-subscriber Webhook Deliveries
// ============================================
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    rowid: rowid(),
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => pendingEvents.id, { onDelete: 'cascade' }),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => eventSubscriptions.id, { onDelete: 'cascade' }),
    status: text('status')
      .$type<'pending' | 'succeeded' | 'failed' | 'dead_letter'>()
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: epochSeconds('next_attempt_at')
      .notNull()
      .default(epochNow),
    lastError: text('last_error'),
    lastStatus: integer('last_status'),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
    completedAt: epochSeconds('completed_at'),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_rowid_unique').on(table.rowid),
    uniqueIndex('webhook_deliveries_event_subscription_unique')
      .on(table.eventId, table.subscriptionId),
    index('idx_webhook_deliveries_due').on(table.status, table.nextAttemptAt),
    index('idx_webhook_deliveries_subscription').on(table.subscriptionId, table.createdAt),
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
export const workspaceEvents = pgTable(
  'workspace_events',
  {
    rowid: rowid(),
    workspaceId: text('workspace_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    channelId: text('channel_id'),
    payload: text('payload').notNull(),
    createdAt: epochSeconds('created_at').notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex('workspace_events_rowid_unique').on(table.rowid),
    primaryKey({ columns: [table.workspaceId, table.seq] }),
    index('idx_workspace_events_created').on(table.workspaceId, table.createdAt),
    index('idx_workspace_events_retention').on(table.createdAt, table.workspaceId, table.seq),
    // Present in the SQLite migration DDL (not declared in schema.ts).
    check('workspace_events_seq_positive_check', sql`${table.seq} > 0`),
  ],
);

/** Durable scan positions; never used as delivery ACKs or event sequence authority. */
export const maintenanceCursors = pgTable('maintenance_cursors', {
  rowid: rowid(),
  id: text('id').primaryKey().notNull(),
  cursor: text('cursor').notNull(),
}, (table) => [uniqueIndex('maintenance_cursors_rowid_unique').on(table.rowid)]);

/** Admission and transport state; inserted atomically with the guarded DM. */
export const a2aEgress = pgTable('a2a_egress', {
  rowid: rowid(),
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull(),
  targetId: text('target_id').notNull(),
  externalUrl: text('external_url').notNull(),
  fingerprint: text('fingerprint').notNull(),
  payload: jsonb('payload').$type<import('@relaycast/a2a').A2aJsonRpcRequest>(),
  status: text('status').notNull().default('pending'),
  claimToken: text('claim_token'),
  leaseUntil: epochSeconds('lease_until'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  errorStatus: integer('error_status'),
  errorCode: text('error_code'),
  createdAt: epochSeconds('created_at').notNull().default(epochNow),
}, (table) => [uniqueIndex('a2a_egress_rowid_unique').on(table.rowid), index('idx_a2a_egress_workspace').on(table.workspaceId), index('idx_a2a_egress_due').on(table.status, table.leaseUntil), index('idx_a2a_egress_retention').on(table.createdAt, table.id)]);

/** Public accepted response only; never transport authentication or mutable target state. */
export const a2aEgressContext = pgTable('a2a_egress_context', {
  rowid: rowid(),
  id: text('id').primaryKey().notNull().references(() => a2aEgress.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  response: json('response').notNull().$type<import('../engine/dm.js').AcceptedDmResult>(),
}, (table) => [uniqueIndex('a2a_egress_context_rowid_unique').on(table.rowid), index('idx_a2a_egress_context_message').on(table.messageId)]);

/** Durable inbound identity. Migration 0059 scrubs response before source deletion;
 * the nullable source FK leaves a content-free tombstone until indexed expiry. */
export const a2aInbound = pgTable('a2a_inbound', {
  rowid: rowid(),
  id: text('id').primaryKey().notNull(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
  fingerprint: text('fingerprint').notNull(),
  response: json('response').$type<import('../engine/dm.js').AcceptedDmResult>(),
  createdAt: epochSeconds('created_at').notNull().default(epochNow),
}, table => [uniqueIndex('a2a_inbound_rowid_unique').on(table.rowid), index('idx_a2a_inbound_workspace').on(table.workspaceId), index('idx_a2a_inbound_message').on(table.messageId), index('idx_a2a_inbound_retention').on(table.createdAt, table.id)]);
