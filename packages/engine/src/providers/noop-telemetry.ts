import type { TelemetrySink, TelemetryEvent } from '../ports/telemetry.js';

/**
 * No-op telemetry — the self-host default. Captures nothing; honors the intent
 * of `DO_NOT_TRACK`. The cloud product injects a PostHog-backed sink.
 *
 * `captureException` still logs to the console so self-host operators see server
 * errors without any external service.
 */
export class NoopTelemetrySink implements TelemetrySink {
  capture(_event: TelemetryEvent): void {
    // intentionally empty
  }

  captureException(err: unknown, context?: Record<string, unknown>): void {
    console.error('[telemetry] captureException', err, context ?? {});
  }
}
