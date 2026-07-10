import type { AppEnv } from "@relayauth/server";

type ServerBindings = AppEnv["Bindings"];

/**
 * Cloudflare Worker bindings required by the RelayAuth Cloudflare storage adapters.
 */
export interface CloudflareStorageBindings extends ServerBindings {
  DB: D1Database;
  IDENTITY_DO: DurableObjectNamespace;
  REVOCATION_KV: KVNamespace;
}

export type CloudflareBindings = CloudflareStorageBindings;
