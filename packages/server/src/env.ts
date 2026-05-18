import type { workspaces, agents } from './db/schema.js';
import type { Logger } from './lib/logger.js';

/** Cloudflare Worker bindings */
export interface CloudflareBindings {
  DB: D1Database;
  FILES_BUCKET: R2Bucket;
  WEBHOOK_QUEUE: Queue;
  NOTIFICATION_QUEUE: Queue;
  CHANNEL_DO: DurableObjectNamespace;
  AGENT_DO: DurableObjectNamespace;
  PRESENCE_DO: DurableObjectNamespace;
  WORKSPACE_STREAM_DO: DurableObjectNamespace;
  MCP_SESSION_DO: DurableObjectNamespace;
  RATE_LIMIT_DO: DurableObjectNamespace;
  KV: KVNamespace;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CF_ACCOUNT_ID: string;
  ENVIRONMENT: string;
  APP_SEMVER?: string;
  APP_VERSION?: string;
  SDK_SEMVER?: string;
  DO_NOT_TRACK?: string;
  RELAYCAST_TELEMETRY_DISABLED?: string;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
}

/** Hono context variables set by middleware */
export interface AppVariables {
  workspace: typeof workspaces.$inferSelect;
  agent: typeof agents.$inferSelect | undefined;
  db: ReturnType<typeof import('./db/index.js').getDb>;
  logger: Logger;
  requestId: string;
  /**
   * Orchestrator harness identifier derived from the X-Relaycast-Harness
   * request header. Always set (defaults to `'unknown'`). Stamped on every
   * server-side telemetry event for the request via `emitServerEvent`.
   */
  orchestratorHarness: string;
}

/** The Hono Env type used throughout the app */
export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
};
