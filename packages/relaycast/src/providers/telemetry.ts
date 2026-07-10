import type { TelemetrySink, TelemetryEvent } from '@relaycast/engine/ports';
import type { InternalTelemetryEvent } from '@relaycast/types';
import type { CloudflareBindings } from '../env.js';
import { captureInternalTelemetryBatched } from '../lib/telemetry.js';
import { captureException } from '../lib/logger.js';
import { flushPostHogClients } from '../lib/posthog.js';

/**
 * Cloud telemetry sink — the proprietary "hosting" provider. Routes engine
 * product-telemetry events and exceptions to PostHog using the existing cloud
 * telemetry/logger helpers. (Self-host uses the engine's NoopTelemetrySink.)
 *
 * The engine folds origin fields into `properties` (see emitServerEvent), so we
 * lift them back out into the dedicated origin shape the PostHog helper expects.
 * (`origin_surface` was dropped from the engine's origin contract in 4.0 / #188,
 * so there is no longer anything to strip here.)
 */
export function createCloudflareTelemetry(env: CloudflareBindings): TelemetrySink {
  return {
    capture(event: TelemetryEvent): void {
      const { origin_client, origin_version, ...properties } =
        (event.properties ?? {}) as Record<string, unknown>;

      void captureInternalTelemetryBatched(env, {
        event: event.name as InternalTelemetryEvent['event'],
        distinct_id: event.distinctId,
        origin: {
          origin_client: origin_client as string | undefined,
          origin_version: origin_version as string | undefined,
        },
        properties,
      });
    },
    captureException(err: unknown, context?: Record<string, unknown>): void {
      void captureException(env, err, { properties: context });
    },
  };
}

/**
 * Flush all buffered cloud-telemetry events to PostHog.
 *
 * The sink returned by {@link createCloudflareTelemetry} only buffers (the
 * posthog-node client batches internally). On Cloudflare Workers that buffer is
 * never drained unless we flush it before the isolate suspends, so every
 * request/queue/cron entrypoint must `ctx.waitUntil(flushCloudflareTelemetry())`
 * after its work completes. See {@link flushPostHogClients}.
 */
export function flushCloudflareTelemetry(): Promise<void> {
  return flushPostHogClients();
}
