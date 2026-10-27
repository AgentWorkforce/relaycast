import type { TelemetrySink, TelemetryEvent } from '../ports/telemetry.js';

/** Self-host default: no outbound observation transport. */
export class NoopTelemetrySink implements TelemetrySink {
  capture(_event: TelemetryEvent): void {
    // intentionally empty
  }

  captureException(err: unknown, context?: Record<string, unknown>): void {
    console.error('[telemetry] captureException', err, context ?? {});
  }
}
