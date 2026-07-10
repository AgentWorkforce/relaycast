import type { DrizzleD1Database } from "drizzle-orm/d1";
import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
} from "@cloudflare/workers-types";
import type * as schema from "./db/schema.js";

export interface Env {
  DB: D1Database;
  SCHEDULER_DO: DurableObjectNamespace;
  ENVIRONMENT: string;
  CLOUD_WEB_WORKER?: Fetcher;
  PROACTIVE_RUNTIME_WORKER?: Fetcher;
  RELAYCRON_API_KEY?: string;
}

export type Database = DrizzleD1Database<typeof schema>;

export interface AuthContext {
  apiKeyId: string;
}

// Extend Hono context
declare module "hono" {
  interface ContextVariableMap {
    db: Database;
    auth: AuthContext;
  }
}
