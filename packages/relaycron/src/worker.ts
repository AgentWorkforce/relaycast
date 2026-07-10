import { createRelaycronApp } from "./app.js";
import { runRelaycronSweep } from "./sweep.js";
import type { Bindings } from "./env.js";

export { SchedulerDO } from "./durable-objects/scheduler.js";
export { createRelaycronApp } from "./app.js";

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return createRelaycronApp(env, ctx).fetch(request, env, ctx);
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runRelaycronSweep(env, ctx);
  },
};
