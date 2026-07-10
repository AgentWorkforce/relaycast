import { drizzle } from 'drizzle-orm/d1';
import {
  SqliteApiKeyAuthProvider,
  schema,
} from '@relaycast/engine';
import type { EngineDeps } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';
import { createCloudflareRealtime, createCloudflareNodeConnections } from './realtime.js';
import { createCloudflarePresence } from './presence.js';
import { createCloudflareRateLimiter } from './rate-limit.js';
import { createCloudflareKv } from './kv.js';
import { createCloudflareEventQueue } from './event-queue.js';
import { createCloudflareFileStorage } from './files.js';
import { createCloudflareTelemetry } from '../../providers/telemetry.js';
import { CloudflareEntitlementsProvider } from './entitlements.js';
import { SERVER_VERSION } from '../../version.js';

export {
  createCloudflareRealtime,
  createCloudflareNodeConnections,
  createCloudflarePresence,
  createCloudflareRateLimiter,
  createCloudflareKv,
  createCloudflareEventQueue,
  createCloudflareFileStorage,
};

/**
 * Assemble the full {@link EngineDeps} from Cloudflare bindings: the DO/D1/R2/
 * KV/Queue adapters plus the hosting providers.
 *
   * Auth reuses the engine's SQLite token lookup because cloud tokens already
   * live in the gateway D1 with the same hashing. Entitlements stay cloud-owned:
   * hosted workspaces default to the free tier while preserving paid workspace
   * plans stored in D1. Telemetry is the other cloud-specific provider (PostHog).
 */
export function createCloudflareEngineDeps(env: CloudflareBindings): EngineDeps {
  const db = drizzle(env.DB, { schema }) as unknown as EngineDeps['db'];
  const realtime = createCloudflareRealtime(env);
  const nodeConnections = createCloudflareNodeConnections(env);
  const kv = createCloudflareKv(env);

  return {
    db,
    realtime,
    connections: realtime,
    nodeConnections,
    presence: createCloudflarePresence(env),
    rateLimiter: createCloudflareRateLimiter(env),
    files: createCloudflareFileStorage(env),
    kv,
    webhookQueue: createCloudflareEventQueue(env),
    auth: new SqliteApiKeyAuthProvider(),
    entitlements: new CloudflareEntitlementsProvider(kv),
    telemetry: createCloudflareTelemetry(env),
    config: {
      environment: env.ENVIRONMENT,
      appVersion: env.APP_VERSION,
      // Checked-in default so `/health` reports a real version instead of the
      // engine's `0.1.0` fallback; a deploy-time `APP_SEMVER` still overrides.
      appSemver: env.APP_SEMVER ?? SERVER_VERSION,
      sdkSemver: env.SDK_SEMVER,
      logExport: {
        posthogApiKey: env.POSTHOG_API_KEY,
        posthogHost: env.POSTHOG_HOST,
      },
    },
  };
}
