// Hono middleware adapter for the shared edge rate limiter.
//
// The actual logic lives in `packages/router/src/rate-limit.ts` so
// both the cloud router worker and this relayfile-api worker apply
// the exact same per-key, per-minute limit semantics and share the
// `RATE_LIMIT_COUNTERS` KV namespace. If a workspace hits both
// gateways, its counter increments in both Workers against the same
// bucket — so the limit applies in aggregate, not per-gateway.
//
// Keeping this as a thin wrapper (rather than duplicating the
// limiter) means any tuning of the algorithm (bucket size, defaults,
// bypass list) happens in one place. The cost is a cross-package
// relative import; both packages already use `moduleResolution:
// bundler` so esbuild and tsc both resolve it cleanly.

import type { MiddlewareHandler } from "hono";
import { maybeRateLimit } from "../../../router/src/rate-limit.js";
import type { AppEnv } from "../env.js";

export const rateLimitMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const blocked = await maybeRateLimit(c.req.raw, {
    RATE_LIMIT_COUNTERS: c.env.RATE_LIMIT_COUNTERS,
    ROUTER_CONFIG: c.env.ROUTER_CONFIG,
  });
  if (blocked) {
    return blocked;
  }
  await next();
};
