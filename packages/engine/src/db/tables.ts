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
import { alias as sqliteAlias } from 'drizzle-orm/sqlite-core';
import type { EngineDialect } from '../ports/engineDb.js';
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

/** The table set a dialect schema module must provide. */
export type EngineSchema = Pick<typeof sqliteSchema, TableName> & { alias: typeof sqliteAlias };

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
      assign({ ...sqliteSchema, alias: sqliteAlias });
      break;
    case 'pg':
      // TODO(#602 step 6): load the generated ./schema.pg.js (with pg-core's alias) and assign it here.
      throw new Error("bindSchema('pg'): schema.pg not available in this build");
    default: {
      const unknown: never = dialect;
      throw new Error(`bindSchema: unsupported dialect ${JSON.stringify(unknown)}`);
    }
  }
  boundDialect = dialect;
}
