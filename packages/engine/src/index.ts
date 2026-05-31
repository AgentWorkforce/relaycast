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
  BroadcastToChannelArgs,
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

// ID generation.
export { generateId, getSnowflakeGenerator, SnowflakeGenerator } from './engine/snowflake.js';
