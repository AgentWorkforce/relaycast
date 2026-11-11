import type { TelemetryEvent, TelemetrySink } from '../ports/telemetry.js';
import {
  BATCH_MAX_BYTES_DEFAULT,
  createBatcher,
  DELIVERY_DEADLINE_DEFAULT_MS,
  EVENT_MAX_BYTES_DEFAULT,
  QUEUE_MAX_BYTES_DEFAULT,
  RETRY_DELAY_MAX_MS,
  type Batcher,
  type BatcherDeps,
  type BatcherStats,
} from '../telemetry/batcher.js';
import {
  projectException,
  projectObservation,
  validateExportEvent,
  type ExportEvent,
  type ExportIdentity,
} from '../telemetry/exportEnvelope.js';
import {
  createHttpCollectorTransport,
  WIRE_BATCH_FRAME_BYTES,
  wireEventBytes,
  type CollectorTransport,
} from '../telemetry/httpTransport.js';
import { NoopTelemetrySink } from './noop-telemetry.js';

export interface CollectorTelemetrySinkOptions {
  /** Collector ingest URL (https, or http to a private in-cluster/loopback host). */
  url: string;
  /** Per-producer collector bearer token. Required; never logged. */
  bearerToken: string;
  /**
   * Explicitly configured, stable installation/deployment identity
   * (`deployment_id`). Required; there is no hostname default. 1-128 chars of
   * `[A-Za-z0-9._:-]`, starting with a letter or digit.
   */
  deployment: string;
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
  /** Longest honored Retry-After, ms (0 ignores it, max 30000). Default 30000. */
  retryAfterMaxMs?: number;
  /**
   * Hostnames of this replica (e.g. `os.hostname()`, `$HOSTNAME`). A
   * deployment id equal to one of them (case-insensitive) is refused: it is a
   * per-pod value, not a stable installation identity.
   */
  replicaHostnames?: readonly (string | undefined)[];
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
  /** Largest serialized (UTF-8) event; larger events are dropped as `oversized`. Default 8192. */
  eventMaxBytes?: number;
  /** Largest serialized (UTF-8) batch body. Default 262144. */
  batchMaxBytes?: number;
  /** Queue byte budget (serialized UTF-8); the newest event over it is dropped as `queueFull`. Default 1048576. */
  queueMaxBytes?: number;
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
  eventMaxBytes: EVENT_MAX_BYTES_DEFAULT,
  batchMaxBytes: BATCH_MAX_BYTES_DEFAULT,
  queueMaxBytes: QUEUE_MAX_BYTES_DEFAULT,
  retryAfterMaxMs: RETRY_DELAY_MAX_MS,
} as const;

/** Analytics destinations this producer can select. PostHog is not one of them (never a fallback). */
export type TelemetryDestination = 'none' | 'collector';
export const TELEMETRY_DESTINATIONS: readonly TelemetryDestination[] = ['none', 'collector'];

/** Stable reason codes for a refused collector configuration. */
export type CollectorConfigErrorCode =
  | 'missing_telemetry_collector_token'
  | 'invalid_telemetry_collector_token'
  | 'missing_telemetry_collector_deployment_id'
  | 'invalid_telemetry_collector_deployment_id'
  | 'missing_telemetry_collector_config'
  | 'unsupported_telemetry_destination';

/** An enabled collector whose configuration is refused at startup. */
export class CollectorConfigError extends Error {
  readonly code: CollectorConfigErrorCode;

  constructor(code: CollectorConfigErrorCode, message: string) {
    super(message);
    this.name = 'CollectorConfigError';
    this.code = code;
  }
}

/** Opaque deployment id: 1-128 chars, `[A-Za-z0-9._:-]`, starting alphanumeric. */
export const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Opaque bearer token: visible ASCII only (no whitespace or control characters), so it fits one header value as-is. */
export const BEARER_TOKEN_PATTERN = /^[\x21-\x7E]+$/;

/**
 * Refuse an enabled collector without a usable bearer token or an explicit,
 * valid deployment id. Never falls back to the hostname or an unauthenticated
 * send. A deployment id equal to one of `replicaHostnames` (a per-pod value)
 * is refused. Error messages never contain the token.
 */
export function validateCollectorIdentity(options: {
  bearerToken?: unknown;
  deployment?: unknown;
  replicaHostnames?: readonly (string | undefined)[];
}): { bearerToken: string; deployment: string } {
  const { bearerToken, deployment } = options;
  if (typeof bearerToken !== 'string' || bearerToken.trim() === '') {
    throw new CollectorConfigError('missing_telemetry_collector_token', 'telemetry collector is enabled but no bearer token is configured');
  }
  if (!BEARER_TOKEN_PATTERN.test(bearerToken)) {
    throw new CollectorConfigError('invalid_telemetry_collector_token', 'telemetry collector bearer token must be visible ASCII without whitespace');
  }
  if (typeof deployment !== 'string' || deployment.trim() === '') {
    throw new CollectorConfigError('missing_telemetry_collector_deployment_id', 'telemetry collector is enabled but no deployment id is configured');
  }
  if (!DEPLOYMENT_ID_PATTERN.test(deployment)) {
    throw new CollectorConfigError('invalid_telemetry_collector_deployment_id', 'telemetry collector deployment id must be 1-128 characters of [A-Za-z0-9._:-], starting with a letter or digit');
  }
  const lower = deployment.toLowerCase();
  for (const host of options.replicaHostnames ?? []) {
    if (typeof host === 'string' && host !== '' && host.toLowerCase() === lower) {
      throw new CollectorConfigError('invalid_telemetry_collector_deployment_id', 'telemetry collector deployment id must be a stable installation identity, not this replica\'s hostname');
    }
  }
  return { bearerToken, deployment };
}

/**
 * Destination factory: resolve an explicit destination selection. `none`
 * disables export; `collector` requires collector options (else a hard
 * configuration error); anything else (including `posthog`) is refused. When
 * no destination is given, collector options alone select the collector.
 * Returns the collector options to use, or `undefined` for no export.
 */
export function resolveTelemetryDestination<T>(destination: unknown, collector: T | undefined): T | undefined {
  if (destination === undefined) return collector;
  if (destination === 'none') return undefined;
  if (destination === 'collector') {
    if (collector === undefined || collector === null) {
      throw new CollectorConfigError('missing_telemetry_collector_config', 'telemetry destination is collector but no collector is configured');
    }
    return collector;
  }
  throw new CollectorConfigError('unsupported_telemetry_destination', `telemetry destination must be one of: ${TELEMETRY_DESTINATIONS.join(', ')}`);
}

/** Collector sink counters: the batcher's plus events refused by the projector/validator. */
export interface CollectorTelemetryStats extends BatcherStats {
  /** Events not exported because they were invalid (missing trace/workspace id, scope or identity mismatch). */
  invalid: number;
}

/**
 * Self-host analytics producer: projects observations into the export envelope
 * and POSTs bounded batches to the installation's collector. Never throws into
 * the caller, never blocks it, and never reports its own failures to a sink.
 */
export class CollectorTelemetrySink implements TelemetrySink {
  private readonly identity: ExportIdentity;
  private readonly batcher: Batcher<ExportEvent>;
  private readonly local: TelemetrySink;
  private invalid = 0;

  constructor(options: CollectorTelemetrySinkOptions) {
    // Required whenever the collector is enabled, even with an injected transport.
    const { bearerToken, deployment } = validateCollectorIdentity(options);
    this.identity = { deployment };
    const transport = options.transport ?? createHttpCollectorTransport({
      url: options.url,
      bearerToken,
      timeoutMs: options.requestTimeoutMs ?? COLLECTOR_TELEMETRY_DEFAULTS.requestTimeoutMs,
      fetch: options.fetch,
    });
    this.batcher = createBatcher<ExportEvent>(transport, {
      queueMax: options.queueMax ?? COLLECTOR_TELEMETRY_DEFAULTS.queueMax,
      batchMax: options.batchMax ?? COLLECTOR_TELEMETRY_DEFAULTS.batchMax,
      flushIntervalMs: options.flushIntervalMs ?? COLLECTOR_TELEMETRY_DEFAULTS.flushIntervalMs,
      maxAttempts: options.maxAttempts ?? COLLECTOR_TELEMETRY_DEFAULTS.maxAttempts,
      backoffMs: options.backoffMs ?? COLLECTOR_TELEMETRY_DEFAULTS.backoffMs,
      retryAfterMaxMs: options.retryAfterMaxMs ?? COLLECTOR_TELEMETRY_DEFAULTS.retryAfterMaxMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? COLLECTOR_TELEMETRY_DEFAULTS.shutdownTimeoutMs,
      deliveryDeadlineMs: options.deliveryDeadlineMs ?? COLLECTOR_TELEMETRY_DEFAULTS.deliveryDeadlineMs,
      eventMaxBytes: options.eventMaxBytes ?? COLLECTOR_TELEMETRY_DEFAULTS.eventMaxBytes,
      batchMaxBytes: options.batchMaxBytes ?? COLLECTOR_TELEMETRY_DEFAULTS.batchMaxBytes,
      queueMaxBytes: options.queueMaxBytes ?? COLLECTOR_TELEMETRY_DEFAULTS.queueMaxBytes,
      // Measured on the exact wire encoding the transport sends.
      sizeOf: wireEventBytes,
      batchFrameBytes: WIRE_BATCH_FRAME_BYTES,
    }, options.batcherDeps);
    this.local = options.local ?? new NoopTelemetrySink();
  }

  capture(event: TelemetryEvent): void {
    try { void Promise.resolve(this.local.capture(event)).catch(() => {}); } catch { /* best effort */ }
    try {
      this.enqueueValid(projectObservation(event, this.identity));
    } catch {
      // A malformed observation is not exported; it never reaches the caller.
    }
  }

  /** Enqueue a projected event, or count it as invalid (missing ids, wrong scope) and drop it. */
  private enqueueValid(event: ExportEvent | null): void {
    if (event === null || validateExportEvent(event, this.identity) !== null) {
      this.invalid += 1;
      return;
    }
    this.batcher.enqueue(event);
  }

  captureException(err: unknown, context?: Record<string, unknown>): void {
    try { void Promise.resolve(this.local.captureException(err, context)).catch(() => {}); } catch { /* best effort */ }
    try {
      this.enqueueValid(projectException(err, context, this.identity));
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

  stats(): CollectorTelemetryStats {
    return { ...this.batcher.stats(), invalid: this.invalid };
  }
}

export function createCollectorTelemetrySink(options: CollectorTelemetrySinkOptions): CollectorTelemetrySink {
  return new CollectorTelemetrySink(options);
}
