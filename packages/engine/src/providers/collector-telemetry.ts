import type { TelemetryEvent, TelemetrySink } from '../ports/telemetry.js';
import { createBatcher, DELIVERY_DEADLINE_DEFAULT_MS, type Batcher, type BatcherDeps, type BatcherStats } from '../telemetry/batcher.js';
import { projectException, projectObservation, type ExportEvent, type ExportIdentity } from '../telemetry/exportEnvelope.js';
import { createHttpCollectorTransport, type CollectorTransport } from '../telemetry/httpTransport.js';
import { NoopTelemetrySink } from './noop-telemetry.js';

export interface CollectorTelemetrySinkOptions {
  /** Collector ingest URL (https, or http to a private in-cluster/loopback host). */
  url: string;
  bearerToken?: string;
  /** Installation label exported on every event. */
  deployment: string;
  /** Replica label exported on every event. */
  instance?: string;
  /** Default 1000. */
  queueMax?: number;
  /** Default 50. */
  batchMax?: number;
  /** Default 2000. */
  flushIntervalMs?: number;
  /** Transport attempts per batch, first try included. Default 3. */
  maxAttempts?: number;
  /** Default 500 (retry n waits n * backoffMs). */
  backoffMs?: number;
  /** Default 5000. */
  shutdownTimeoutMs?: number;
  /**
   * Total delivery deadline per event, from enqueue across queued time, every
   * attempt and every retry wait; splits and retries never extend it. Expired
   * events are dropped and counted. Default 60000.
   */
  deliveryDeadlineMs?: number;
  /** Per-attempt request timeout, clipped to the remaining delivery deadline. Default 5000. */
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Replace the HTTP transport (tests). */
  transport?: CollectorTransport;
  /**
   * Local sink also given every call (default: the no-op sink, which keeps
   * printing `captureException` to stderr exactly as before).
   */
  local?: TelemetrySink;
  /** Timer/clock/log injection for the batcher (tests). */
  batcherDeps?: BatcherDeps;
}

export const COLLECTOR_TELEMETRY_DEFAULTS = {
  queueMax: 1000,
  batchMax: 50,
  flushIntervalMs: 2000,
  maxAttempts: 3,
  backoffMs: 500,
  shutdownTimeoutMs: 5000,
  deliveryDeadlineMs: DELIVERY_DEADLINE_DEFAULT_MS,
  requestTimeoutMs: 5000,
} as const;

/**
 * Self-host analytics producer: projects observations into the export envelope
 * and POSTs bounded batches to the installation's collector. Never throws into
 * the caller, never blocks it, and never reports its own failures to a sink.
 */
export class CollectorTelemetrySink implements TelemetrySink {
  private readonly identity: ExportIdentity;
  private readonly batcher: Batcher<ExportEvent>;
  private readonly local: TelemetrySink;

  constructor(options: CollectorTelemetrySinkOptions) {
    if (typeof options.deployment !== 'string' || options.deployment.trim() === '') {
      throw new Error('telemetry collector deployment must be a non-empty string');
    }
    this.identity = { deployment: options.deployment, ...(options.instance ? { instance: options.instance } : {}) };
    const transport = options.transport ?? createHttpCollectorTransport({
      url: options.url,
      bearerToken: options.bearerToken,
      timeoutMs: options.requestTimeoutMs ?? COLLECTOR_TELEMETRY_DEFAULTS.requestTimeoutMs,
      fetch: options.fetch,
    });
    this.batcher = createBatcher<ExportEvent>(transport, {
      queueMax: options.queueMax ?? COLLECTOR_TELEMETRY_DEFAULTS.queueMax,
      batchMax: options.batchMax ?? COLLECTOR_TELEMETRY_DEFAULTS.batchMax,
      flushIntervalMs: options.flushIntervalMs ?? COLLECTOR_TELEMETRY_DEFAULTS.flushIntervalMs,
      maxAttempts: options.maxAttempts ?? COLLECTOR_TELEMETRY_DEFAULTS.maxAttempts,
      backoffMs: options.backoffMs ?? COLLECTOR_TELEMETRY_DEFAULTS.backoffMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? COLLECTOR_TELEMETRY_DEFAULTS.shutdownTimeoutMs,
      deliveryDeadlineMs: options.deliveryDeadlineMs ?? COLLECTOR_TELEMETRY_DEFAULTS.deliveryDeadlineMs,
    }, options.batcherDeps);
    this.local = options.local ?? new NoopTelemetrySink();
  }

  capture(event: TelemetryEvent): void {
    try { void Promise.resolve(this.local.capture(event)).catch(() => {}); } catch { /* best effort */ }
    try {
      const projected = projectObservation(event, this.identity);
      if (projected) this.batcher.enqueue(projected);
    } catch {
      // A malformed observation is not exported; it never reaches the caller.
    }
  }

  captureException(err: unknown, context?: Record<string, unknown>): void {
    try { void Promise.resolve(this.local.captureException(err, context)).catch(() => {}); } catch { /* best effort */ }
    try {
      this.batcher.enqueue(projectException(err, context, this.identity));
    } catch {
      // classification is best effort
    }
  }

  /** Send what is queued now. */
  flush(): Promise<void> {
    return this.batcher.flush();
  }

  /** Stop accepting events and drain, bounded by `shutdownTimeoutMs`. Idempotent. */
  close(): Promise<void> {
    return this.batcher.shutdown();
  }

  stats(): BatcherStats {
    return this.batcher.stats();
  }
}

export function createCollectorTelemetrySink(options: CollectorTelemetrySinkOptions): CollectorTelemetrySink {
  return new CollectorTelemetrySink(options);
}
