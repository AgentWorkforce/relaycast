/**
 * Pluggable telemetry sink — the observability seam.
 *
 * Self-host uses `NoopTelemetrySink` (honors `DO_NOT_TRACK` / explicit disable).
 * The cloud product injects a PostHog-backed sink. All methods are
 * fire-and-forget from the engine's perspective; the sink decides batching and
 * background flushing.
 */
export interface TelemetryEvent {
  /** Event name, e.g. `relaycast_server_message_posted`. */
  name: string;
  /** Stable per-workspace (or per-actor) id for aggregation. */
  distinctId: string;
  properties: Record<string, unknown>;
}

export interface TelemetrySink {
  capture(event: TelemetryEvent): void;
  captureException(err: unknown, context?: Record<string, unknown>): void;
}
