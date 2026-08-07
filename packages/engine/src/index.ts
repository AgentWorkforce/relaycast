export const SERVER_VERSION = '0.1.0' as const;

// The engine factory + the Hono Env type consumers extend.
export { createEngine } from './engine.js';
export type { AppEnv, AppVariables, EngineRuntime } from './env.js';

// The full dependency contract: ports + providers + config.
export type {
  EngineDeps,
  EnginePorts,
  EngineProviders,
  EngineConfig,
  EngineDb,
  EngineEvent,
  RealtimeBus,
  ConnectionRegistry,
  UpgradeArgs,
  PresenceTracker,
  RateLimiter,
  RateLimitResult,
  FileStorage,
  KeyValueStore,
  EventQueue,
  QueuedEvent,
  AuthProvider,
  AuthResult,
  AuthRequire,
  Workspace,
  Agent,
  EntitlementsProvider,
  PlanLimits,
  UsageMetric,
  TelemetrySink,
  TelemetryEvent,
} from './ports/index.js';

// OSS default providers (self-host). Cloud injects its own.
export { SqliteApiKeyAuthProvider, hashToken } from './auth/index.js';
export { StaticEntitlementsProvider, PLAN_LIMITS } from './providers/static-entitlements.js';
export { NoopTelemetrySink } from './providers/noop-telemetry.js';

// Database helpers + schema for adapters and migrations.
export { getDb, healthCheck as dbHealthCheck } from './db/index.js';
export type { Db } from './db/index.js';
export * as schema from './db/schema.js';

// Webhook delivery + scheduled-task helpers adapters wire to their queue/cron.
export { deliverEvent } from './engine/eventDelivery.js';
export { runA2aHealthChecks } from './engine/a2a-health.js';

// Node delivery redrive: queue/cron-backed deployments call this from a
// scheduled handler to retry queued node deliveries (http_push and ws-node)
// whose `next_attempt_at` is due (or was never stamped). The Node adapter wires
// the same helper to its local maintenance interval for self-hosted runtimes.
// `sweepDueHttpPushDeliveries` is a deprecated alias kept for hosts (relaycast-
// cloud) that still import the old name.
export { sweepDueNodeDeliveries, sweepDueHttpPushDeliveries } from './routes/deliveryRouting.js';
export { sweepExpiredDeliveries } from './routes/deliveryRouting.js';
export { deliverPendingToNode } from './engine/delivery.js';
export { handleNodeReconnect } from './node-reconnect.js';
export { handleAgentDisconnect } from './agent-disconnect.js';
export { drainNodeInvocations, sweepTimedOutInvocations } from './node-invocations.js';
export { AGENT_LIVENESS_TTL_MS, effectiveAgentStatus, sweepStaleAgents } from './engine/agent.js';
export type { SweepTimedOutInvocationsOptions } from './node-invocations.js';
export { handleNodeControlMessage } from './engine/node.js';
export type { HandleNodeControlMessageArgs, NodeSocketLike } from './engine/node.js';

// `pending_events` outbox primitives for queue-backed deployments: the queue
// consumer settles rows (`completeEvent` / `failEvent` / `rescheduleEvent`)
// and a scheduled sweep re-enqueues lost ones (`sweepPendingEvents`) and
// prunes settled ones (`cleanupOldEvents`).
export {
  enqueueEvent,
  claimDueEvents,
  completeEvent,
  failEvent,
  rescheduleEvent,
  sweepPendingEvents,
  cleanupOldEvents,
} from './engine/eventQueue.js';
export type { ClaimedEvent, SweptEvent } from './engine/eventQueue.js';

// Retention pruning: bounded-batch deletion of expired messages, settled
// deliveries, message logs, and orphaned read receipts. The Node adapter runs
// it on the outbox cleanup cadence; queue-backed deployments call it from a
// scheduled handler.
export {
  pruneExpired,
  DEFAULT_DELIVERY_TTL_DAYS,
  DEFAULT_MESSAGE_LOG_TTL_DAYS,
  DEFAULT_WORKSPACE_EVENT_TTL_DAYS,
} from './engine/retention.js';
export type { PruneOptions, PruneResult, RetentionDefaults } from './engine/retention.js';
export type { WorkspaceRetentionSettings } from './db/schema.js';

// Durable workspace event log (observer plane): append + cursor reads over
// `workspace_events`, and the shared append+stamp+publish helper used by every
// workspace stream call site.
export {
  appendWorkspaceEvent,
  appendAndPublishWorkspaceEvent,
  listWorkspaceEvents,
  WORKSPACE_EVENT_LIST_DEFAULT_LIMIT,
  WORKSPACE_EVENT_LIST_MAX_LIMIT,
} from './engine/workspaceEvents.js';
export type { WorkspaceEventInput, WorkspaceEventRecord } from './engine/workspaceEvents.js';

// ID generation.
export {
  generateId,
  getSnowflakeGenerator,
  snowflakeIdLowerBound,
  SnowflakeGenerator,
} from './engine/snowflake.js';
