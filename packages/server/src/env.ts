import type { workspaces, agents } from './db/schema.js';

/** Cloudflare Worker bindings */
export interface CloudflareBindings {
  DB: D1Database;
  FILES_BUCKET: R2Bucket;
  WEBHOOK_QUEUE: Queue;
  NOTIFICATION_QUEUE: Queue;
  CHANNEL_DO: DurableObjectNamespace;
  AGENT_DO: DurableObjectNamespace;
  PRESENCE_DO: DurableObjectNamespace;
  MCP_SESSION_DO: DurableObjectNamespace;
  KV: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  CF_ACCOUNT_ID: string;
  ENVIRONMENT: string;
}

/** Hono context variables set by middleware */
export interface AppVariables {
  workspace: typeof workspaces.$inferSelect;
  agent: typeof agents.$inferSelect | undefined;
  db: ReturnType<typeof import('./db/index.js').getDb>;
}

/** The Hono Env type used throughout the app */
export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
};
