/**
 * The complete dependency contract for the Relaycast engine.
 *
 * Everything platform-specific is expressed here as an interface. An adapter
 * (Node in-process for self-host; Cloudflare DO for the hosted product) provides
 * concrete implementations, and `createEngine(deps)` wires them into the Hono app.
 *
 * Two groups:
 *  - **Ports** — infrastructure the engine needs (db, realtime, presence, rate
 *    limiting, file blobs, key/value).
 *  - **Providers** — the open-core "hosting" seam the cloud layer overrides
 *    (auth, entitlements/billing, telemetry). Each ships an OSS default.
 */
export type {
  EngineDb,
  TransactionCapability,
  BatchCapability,
  AtomicWrite,
  AtomicWriteBuilder,
  AtomicWriteInput,
} from './database.js';
export { runAtomic, runAtomicWrites } from './database.js';
export type {
  EngineEvent,
  RealtimeBus,
  ConnectionRegistry,
  NodeConnectionRegistry,
  BroadcastToChannelArgs,
  UpgradeArgs,
  NodeUpgradeArgs,
} from './realtime.js';
export type { PresenceTracker } from './presence.js';
export type { RateLimiter, RateLimitResult } from './rate-limit.js';
export type { FileStorage } from './files.js';
export type { KeyValueStore } from './kv.js';
export type { EventQueue, QueuedEvent } from './event-queue.js';
export type {
  AuthProvider,
  AuthResult,
  AuthRequire,
  Workspace,
  Agent,
} from './auth.js';
export type {
  EntitlementsProvider,
  PlanLimits,
  UsageMetric,
} from './entitlements.js';
export type { TelemetrySink, TelemetryEvent } from './telemetry.js';

import type { EngineDb } from './database.js';
import type { RealtimeBus, ConnectionRegistry, NodeConnectionRegistry } from './realtime.js';
import type { PresenceTracker } from './presence.js';
import type { RateLimiter } from './rate-limit.js';
import type { FileStorage } from './files.js';
import type { KeyValueStore } from './kv.js';
import type { EventQueue } from './event-queue.js';
import type { AuthProvider } from './auth.js';
import type { EntitlementsProvider } from './entitlements.js';
import type { TelemetrySink } from './telemetry.js';

/** Infrastructure ports the engine reads off the request context. */
export interface EnginePorts {
  db: EngineDb;
  realtime: RealtimeBus;
  connections: ConnectionRegistry;
  nodeConnections: NodeConnectionRegistry;
  presence: PresenceTracker;
  rateLimiter: RateLimiter;
  files: FileStorage;
  kv: KeyValueStore;
  webhookQueue: EventQueue;
}

/** The open-core hosting seam — each has an OSS default in `../auth`, etc. */
export interface EngineProviders {
  auth: AuthProvider;
  entitlements: EntitlementsProvider;
  telemetry: TelemetrySink;
}

/** Everything `createEngine` needs. */
export interface EngineDeps extends EnginePorts, EngineProviders {
  /**
   * Optional runtime config (file storage bucket hints, environment label,
   * feature flags). Adapters pass what they need; the engine treats it as opaque
   * read-only metadata.
   */
  config?: EngineConfig;
}

export interface EngineConfig {
  environment?: string;
  appVersion?: string;
  appSemver?: string;
  sdkSemver?: string;
  /**
   * When set, the structured logger exports prod logs to a PostHog OTLP endpoint
   * via plain fetch (no posthog-node dependency). Self-host leaves this unset and
   * logs to the console only; cloud wires it from its secrets.
   */
  logExport?: {
    posthogApiKey?: string;
    posthogHost?: string;
  };
  /**
   * Default for the workspace event stream (`rk_live_` WS). When false (the
   * self-host default), the workspace-wide stream is disabled unless explicitly
   * enabled per workspace via the KV override.
   */
  workspaceStreamEnabled?: boolean;
}
