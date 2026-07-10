import { createApp } from "@relaycron/server";
import { createD1Database } from "./d1-database.js";
import { DurableObjectScheduler } from "./do-scheduler.js";
import type { Bindings } from "./env.js";

export function createRelaycronApp(
  env: Bindings,
  ctx: ExecutionContext,
) {
  const db = createD1Database(env.DB);
  const scheduler = new DurableObjectScheduler(env.SCHEDULER_DO, ctx);

  return createApp(db as any, scheduler as any);
}
