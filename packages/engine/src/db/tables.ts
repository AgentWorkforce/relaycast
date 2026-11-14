/**
 * Dialect-bound table references for engine code.
 *
 * Engine modules import tables from here, never from `schema.ts` directly.
 * Each export is an ESM live binding assigned once per process by
 * {@link bindSchema}: `'sqlite'` binds the tables of `schema.ts`, `'pg'` will
 * bind the generated `schema.pg.ts`. Binding fails closed:
 *
 * - touching any table (or `alias`) before `bindSchema` throws;
 * - binding a second, different dialect in the same process throws.
 *
 * SQLite adapters bind through `brandSqliteEngineDb`; the test harness binds in
 * vitest `setupFiles`. The cloud D1 adapter (outside this package) must either
 * brand its handle or call `bindSchema('sqlite')` itself.
 */
import { getTableName, is, type Column, type ColumnDataType, type Table } from 'drizzle-orm';
import { PgTable, alias as pgAlias } from 'drizzle-orm/pg-core';
import { SQLiteTable, alias as sqliteAlias } from 'drizzle-orm/sqlite-core';
import type { EngineDialect } from '../ports/engineDb.js';
import * as pgSchema from './schema.pg.js';
import * as sqliteSchema from './schema.js';

export type {
  ObserverTokenFilters,
  TaskInvocationState,
  WorkspaceProvenanceRecord,
  WorkspaceRetentionSettings,
} from './schema.js';

type TableName =
  | 'workspaces'
  | 'workspaceCreateIdempotency'
  | 'credentialUpgrades'
  | 'agents'
  | 'agentRecoveryCredentials'
  | 'agentIdentityAudit'
  | 'nodes'
  | 'nodeProviders'
  | 'observerTokens'
  | 'agentNodeBindings'
  | 'a2aAgents'
  | 'directoryAgents'
  | 'directorySkills'
  | 'directoryRatings'
  | 'routingConfigs'
  | 'routingFailures'
  | 'certifications'
  | 'channels'
  | 'channelMembers'
  | 'messages'
  | 'directDmIdempotency'
  | 'messageSessions'
  | 'messageLogs'
  | 'reactions'
  | 'dmConversations'
  | 'dmConversationReservations'
  | 'dmParticipants'
  | 'files'
  | 'fileCleanupQueue'
  | 'messageAttachments'
  | 'readReceipts'
  | 'usageRecords'
  | 'webhooks'
  | 'eventSubscriptions'
  | 'actions'
  | 'actionInvocations'
  | 'triggers'
  | 'sessionEvents'
  | 'deliveries'
  | 'pendingEvents'
  | 'webhookDeliveries'
  | 'workspaceEvents'
  | 'maintenanceCursors'
  | 'a2aEgress'
  | 'a2aEgressContext'
  | 'a2aInbound';

/**
 * A column re-homed onto drizzle's base `Column`: the engine-visible facts
 * (SQL name, table name, JS data type, nullability, default/primary-key flags
 * that drive insert-model inference, enum values) are kept from the SQLite
 * declaration, which is the contract engine code was written against; the
 * dialect-specific facts (`columnType`, `dataType`, `driverParam` and the
 * `dialect` type tag) are widened. A SQLite or a PG column with the same
 * engine-visible facts is assignable to it, so both schema modules bind below
 * without a cast, and a PG declaration that drifts in data type, nullability
 * or insert optionality fails this assignment at compile time.
 */
export type EngineColumn<C extends Column> = Column<{
  name: C['_']['name'];
  tableName: C['_']['tableName'];
  dataType: ColumnDataType;
  columnType: string;
  data: C['_']['data'];
  driverParam: unknown;
  notNull: C['_']['notNull'];
  hasDefault: C['_']['hasDefault'];
  isPrimaryKey: C['_']['isPrimaryKey'];
  isAutoincrement: C['_']['isAutoincrement'];
  hasRuntimeDefault: C['_']['hasRuntimeDefault'];
  enumValues: C['_']['enumValues'];
  // Pinned so drizzle's insert-model inference treats defaulted/nullable
  // columns as optional keys (it requires both to be exactly undefined).
  // No engine-visible column is generated or an identity; the PG-only
  // `rowid` identity is not part of this shape.
  generated: undefined;
  identity: undefined;
}>;

type EngineColumns<TColumns extends Record<string, Column>> = { [K in keyof TColumns]: EngineColumn<TColumns[K]> };

/**
 * A table on drizzle's base `Table` (dialect `string`, schema `string |
 * undefined`) whose columns are {@link EngineColumn}s, plus the column
 * properties drizzle's `*TableWithColumns` types expose. Extra columns a
 * dialect adds (the PG `rowid` identity) are allowed: they are structurally
 * extra, never required on insert (generated always), and invisible to
 * engine code typed against this.
 */
export type EngineTable<T extends Table> = Table<{
  name: T['_']['name'];
  schema: string | undefined;
  columns: EngineColumns<T['_']['columns']>;
  dialect: string;
}> &
  EngineColumns<T['_']['columns']>;

/**
 * `alias(table, name)`: a renamed reference to a bound table, typed as the
 * table itself so column refs keep their engine-visible types. Each binding
 * supplies a wrapper around its dialect's own `alias` that checks the table
 * class at runtime (a table from the other dialect is refused, never aliased).
 */
interface EngineAliasHolder {
  alias<T extends Table, TAlias extends string>(table: T, alias: TAlias): T;
}

function sqliteEngineAlias<T extends Table, TAlias extends string>(table: T, name: TAlias): T {
  if (!is(table, SQLiteTable)) throw new Error(`alias(): table "${getTableName(table)}" is not a SQLite table; this process is bound to 'sqlite'`);
  // drizzle types the alias as a renamed table; engine code only reads its
  // column refs, which have the same engine-visible shape as T's.
  return sqliteAlias(table, name) as unknown as T;
}

function pgEngineAlias<T extends Table, TAlias extends string>(table: T, name: TAlias): T {
  if (!is(table, PgTable)) throw new Error(`alias(): table "${getTableName(table)}" is not a PostgreSQL table; this process is bound to 'pg'`);
  // Same reasoning as sqliteEngineAlias.
  return pgAlias(table, name) as unknown as T;
}

/** The table set a dialect schema module must provide, typed dialect-neutrally. */
export type EngineSchema = { [K in TableName]: EngineTable<(typeof sqliteSchema)[K]> } & EngineAliasHolder;

function unbound<T>(name: string, target: object = {}): T {
  const fail = (): never => {
    throw new Error(`db/tables: '${name}' read before bindSchema(); no engine dialect is bound in this process`);
  };
  // Every proxy trap throws, so even `is(x, Table)` or property enumeration on
  // an unbound table fails loudly instead of yielding undefined. Tables keep an
  // object target (drizzle's `is()` returns false for functions without
  // touching them); `alias` gets a function target so calling it throws too.
  return new Proxy(target, new Proxy({}, { get: () => fail })) as T;
}

export let workspaces: EngineSchema['workspaces'] = unbound('workspaces');
export let workspaceCreateIdempotency: EngineSchema['workspaceCreateIdempotency'] = unbound('workspaceCreateIdempotency');
export let credentialUpgrades: EngineSchema['credentialUpgrades'] = unbound('credentialUpgrades');
export let agents: EngineSchema['agents'] = unbound('agents');
export let agentRecoveryCredentials: EngineSchema['agentRecoveryCredentials'] = unbound('agentRecoveryCredentials');
export let agentIdentityAudit: EngineSchema['agentIdentityAudit'] = unbound('agentIdentityAudit');
export let nodes: EngineSchema['nodes'] = unbound('nodes');
export let nodeProviders: EngineSchema['nodeProviders'] = unbound('nodeProviders');
export let observerTokens: EngineSchema['observerTokens'] = unbound('observerTokens');
export let agentNodeBindings: EngineSchema['agentNodeBindings'] = unbound('agentNodeBindings');
export let a2aAgents: EngineSchema['a2aAgents'] = unbound('a2aAgents');
export let directoryAgents: EngineSchema['directoryAgents'] = unbound('directoryAgents');
export let directorySkills: EngineSchema['directorySkills'] = unbound('directorySkills');
export let directoryRatings: EngineSchema['directoryRatings'] = unbound('directoryRatings');
export let routingConfigs: EngineSchema['routingConfigs'] = unbound('routingConfigs');
export let routingFailures: EngineSchema['routingFailures'] = unbound('routingFailures');
export let certifications: EngineSchema['certifications'] = unbound('certifications');
export let channels: EngineSchema['channels'] = unbound('channels');
export let channelMembers: EngineSchema['channelMembers'] = unbound('channelMembers');
export let messages: EngineSchema['messages'] = unbound('messages');
export let directDmIdempotency: EngineSchema['directDmIdempotency'] = unbound('directDmIdempotency');
export let messageSessions: EngineSchema['messageSessions'] = unbound('messageSessions');
export let messageLogs: EngineSchema['messageLogs'] = unbound('messageLogs');
export let reactions: EngineSchema['reactions'] = unbound('reactions');
export let dmConversations: EngineSchema['dmConversations'] = unbound('dmConversations');
export let dmConversationReservations: EngineSchema['dmConversationReservations'] = unbound('dmConversationReservations');
export let dmParticipants: EngineSchema['dmParticipants'] = unbound('dmParticipants');
export let files: EngineSchema['files'] = unbound('files');
export let fileCleanupQueue: EngineSchema['fileCleanupQueue'] = unbound('fileCleanupQueue');
export let messageAttachments: EngineSchema['messageAttachments'] = unbound('messageAttachments');
export let readReceipts: EngineSchema['readReceipts'] = unbound('readReceipts');
export let usageRecords: EngineSchema['usageRecords'] = unbound('usageRecords');
export let webhooks: EngineSchema['webhooks'] = unbound('webhooks');
export let eventSubscriptions: EngineSchema['eventSubscriptions'] = unbound('eventSubscriptions');
export let actions: EngineSchema['actions'] = unbound('actions');
export let actionInvocations: EngineSchema['actionInvocations'] = unbound('actionInvocations');
export let triggers: EngineSchema['triggers'] = unbound('triggers');
export let sessionEvents: EngineSchema['sessionEvents'] = unbound('sessionEvents');
export let deliveries: EngineSchema['deliveries'] = unbound('deliveries');
export let pendingEvents: EngineSchema['pendingEvents'] = unbound('pendingEvents');
export let webhookDeliveries: EngineSchema['webhookDeliveries'] = unbound('webhookDeliveries');
export let workspaceEvents: EngineSchema['workspaceEvents'] = unbound('workspaceEvents');
export let maintenanceCursors: EngineSchema['maintenanceCursors'] = unbound('maintenanceCursors');
export let a2aEgress: EngineSchema['a2aEgress'] = unbound('a2aEgress');
export let a2aEgressContext: EngineSchema['a2aEgressContext'] = unbound('a2aEgressContext');
export let a2aInbound: EngineSchema['a2aInbound'] = unbound('a2aInbound');
export let alias: EngineSchema['alias'] = unbound('alias', function unboundAlias() {});

function assign(s: EngineSchema): void {
  workspaces = s.workspaces;
  workspaceCreateIdempotency = s.workspaceCreateIdempotency;
  credentialUpgrades = s.credentialUpgrades;
  agents = s.agents;
  agentRecoveryCredentials = s.agentRecoveryCredentials;
  agentIdentityAudit = s.agentIdentityAudit;
  nodes = s.nodes;
  nodeProviders = s.nodeProviders;
  observerTokens = s.observerTokens;
  agentNodeBindings = s.agentNodeBindings;
  a2aAgents = s.a2aAgents;
  directoryAgents = s.directoryAgents;
  directorySkills = s.directorySkills;
  directoryRatings = s.directoryRatings;
  routingConfigs = s.routingConfigs;
  routingFailures = s.routingFailures;
  certifications = s.certifications;
  channels = s.channels;
  channelMembers = s.channelMembers;
  messages = s.messages;
  directDmIdempotency = s.directDmIdempotency;
  messageSessions = s.messageSessions;
  messageLogs = s.messageLogs;
  reactions = s.reactions;
  dmConversations = s.dmConversations;
  dmConversationReservations = s.dmConversationReservations;
  dmParticipants = s.dmParticipants;
  files = s.files;
  fileCleanupQueue = s.fileCleanupQueue;
  messageAttachments = s.messageAttachments;
  readReceipts = s.readReceipts;
  usageRecords = s.usageRecords;
  webhooks = s.webhooks;
  eventSubscriptions = s.eventSubscriptions;
  actions = s.actions;
  actionInvocations = s.actionInvocations;
  triggers = s.triggers;
  sessionEvents = s.sessionEvents;
  deliveries = s.deliveries;
  pendingEvents = s.pendingEvents;
  webhookDeliveries = s.webhookDeliveries;
  workspaceEvents = s.workspaceEvents;
  maintenanceCursors = s.maintenanceCursors;
  a2aEgress = s.a2aEgress;
  a2aEgressContext = s.a2aEgressContext;
  a2aInbound = s.a2aInbound;
  alias = s.alias;
}

let boundDialect: EngineDialect | undefined;

/** The dialect bound in this process, or `undefined` before {@link bindSchema}. */
export function currentSchemaDialect(): EngineDialect | undefined {
  return boundDialect;
}

/**
 * Bind every table export to `dialect`'s schema. Idempotent for the same
 * dialect; throws if the process is already bound to a different one.
 */
export function bindSchema(dialect: EngineDialect): void {
  if (boundDialect === dialect) return;
  if (boundDialect !== undefined) {
    throw new Error(`bindSchema('${dialect}'): process is already bound to '${boundDialect}'`);
  }
  switch (dialect) {
    case 'sqlite':
      assign({ ...sqliteSchema, alias: sqliteEngineAlias });
      break;
    case 'pg':
      assign({ ...pgSchema, alias: pgEngineAlias });
      break;
    default: {
      const unknown: never = dialect;
      throw new Error(`bindSchema: unsupported dialect ${JSON.stringify(unknown)}`);
    }
  }
  boundDialect = dialect;
}
