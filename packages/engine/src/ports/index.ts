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
  UpgradeArgs,
  NodeUpgradeArgs,
} from './realtime.js';
export { isProviderAgentDeliveryReady } from './realtime.js';
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
   * Master secret used to derive relayfile -> relaycast inbound HMAC secrets.
   * Hosted adapters wire this from their internal secret; self-host can omit it
   * to disable the relayfile inbound bridge.
   */
  relayfileInboundSecret?: string;
  /**
   * Optional egress proxy for http_push node delivery. When set, nodes that
   * register with `delivery.use_proxy: true` have their webhook POST routed
   * through this forwarder instead of hitting the destination directly — the
   * real target is passed via the `X-Forward-To` header and authenticated with
   * `secret` (sent as `X-Proxy-Auth`). Used to reach receivers that block the
   * engine's own network origin (e.g. a webhook behind Cloudflare bot rules that
   * rejects Cloudflare Workers). Hosted adapters wire this from their secrets.
   */
  httpPushProxy?: {
    url?: string;
    secret?: string;
  };
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
   * Bounded durable mailbox tuning. Hosted adapters may provide workspace
   * overrides; self-host defaults to one hour TTL and 1000 in-flight deliveries
   * per agent.
   */
  mailbox?: {
    deliveryTtlMs?: number;
    depthCap?: number;
    workspaces?: Record<string, {
      deliveryTtlMs?: number;
      depthCap?: number;
    }>;
  };
}
