/**
 * HTTP transport to the self-host analytics collector Service. Every wire
 * decision lives here (body shape, auth header, status handling); projection
 * (exportEnvelope.ts) and batching (batcher.ts) do not depend on any of them.
 *
 * Contract: the collector's internal batch endpoint (`POST /v1/events`,
 * agent-relay infra "Self-host analytics collector interface"). The operator
 * configures the complete endpoint URL, including `/v1/events`; no path is
 * ever appended. The URL carries no credentials, query or fragment.
 *
 * Request: `POST <url>`, `content-type: application/json`, required
 * `authorization: Bearer <per-producer credential>`, body
 * `{ "schema": "agent-relay.analytics.batch/v1", "events": [WireEvent...] }`.
 *
 * Each attempt is aborted after the configured request timeout, or sooner when
 * the batcher passes a shorter `timeoutMs` (the remaining total delivery or
 * shutdown deadline).
 *
 * Responses (thrown as {@link CollectorExportError}, which carries the
 * batcher's {@link ExportFailureHint}):
 * - 204: accepted; the only status that acknowledges a batch.
 * - any other 2xx (200, 202, 206, ...): a protocol error, never accepted.
 *   Retryable within the finite attempt budget, then dropped and counted.
 * - 400, 401, 403, other 4xx: terminal; the batch is dropped and counted.
 *   401/403 are reported as a producer-credential configuration failure
 *   (the batcher counts `configFailures` and logs it on its own rate limit).
 * - 413: terminal for that batch; the batcher splits it in halves, and a
 *   single oversized event is dropped.
 * - 408, 429, 503, 507, other 5xx, timeout, connection failure: retryable;
 *   an unsigned delta-seconds `Retry-After` (capped at
 *   {@link RETRY_DELAY_MAX_MS}; the batcher further clips the wait to the
 *   shutdown deadline) is honored on 429/503/507. HTTP-date and malformed
 *   values are ignored and the local backoff applies. A zero value never
 *   permits more than the configured attempts.
 * - 3xx: never followed (credentials are never forwarded); terminal.
 * Response bodies are never read or logged.
 *
 * Destination rule: `https:` to any host; plaintext `http:` only to a host that
 * cannot be a public internet authority: `localhost` (or `*.localhost`),
 * `127.0.0.1`, `[::1]`, a Kubernetes Service name ending in `.svc` or
 * `.svc.cluster.local`, or a single-label hostname (a container/Service short
 * name such as `collector`). Credentials, a query string or a fragment in
 * the URL are refused; use the bearer token. There is no fallback
 * destination: a failed send fails.
 */
import { RETRY_DELAY_MAX_MS, type BatchAttempt, type ExportFailureHint } from './batcher.js';
import type { ExportEvent, ExportFactValue } from './exportEnvelope.js';

/** `schema` value of every batch body. */
export const COLLECTOR_BATCH_SCHEMA = 'agent-relay.analytics.batch/v1' as const;

/** Collector event envelope `version`. */
export const COLLECTOR_EVENT_VERSION = 1 as const;

/**
 * Top-level wire event fields. `properties` may never carry one of these
 * names (the collector rejects an override of a reserved field).
 */
export const COLLECTOR_RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'event_id',
  'occurred_at',
  'component',
  'deployment_id',
  'event',
  'trace_id',
  'tenant_id',
  'workspace_id',
  'properties',
]);

export interface WireEvent {
  version: typeof COLLECTOR_EVENT_VERSION;
  event_id: string;
  occurred_at: string;
  component: string;
  deployment_id: string;
  event: string;
  /** Always present: the request id, or a UUID created once at projection. */
  trace_id: string;
  // tenant_id: never sent. Relaycast is a "native workspace with no separate
  // tenant model": workspace events carry workspace_id only, and
  // installation-only events (an exception outside a workspace) carry
  // neither. A tenant id is never invented or set equal to the workspace id.
  workspace_id?: string;
  properties: Record<string, ExportFactValue>;
}

export interface WireBatch {
  schema: typeof COLLECTOR_BATCH_SCHEMA;
  events: WireEvent[];
}

/**
 * Map an internal export event to the collector wire shape. Pure. `facts`
 * plus the envelope's `actor_type` and `origin` (flattened to `origin_app`,
 * `origin_actor_type`, `origin_client`) become `properties`; reserved field
 * names are stripped from `properties`.
 */
export function toWireEvent(event: ExportEvent): WireEvent {
  const properties: Record<string, ExportFactValue> = {};
  const put = (key: string, value: ExportFactValue | undefined): void => {
    if (value === undefined || COLLECTOR_RESERVED_FIELDS.has(key) || key === '__proto__') return;
    properties[key] = value;
  };
  for (const [key, value] of Object.entries(event.facts)) put(key, value);
  put('actor_type', event.actor_type);
  if (event.origin) {
    put('origin_app', event.origin.app);
    put('origin_actor_type', event.origin.actor_type);
    put('origin_client', event.origin.client);
  }
  return {
    version: COLLECTOR_EVENT_VERSION,
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    component: event.component,
    deployment_id: event.deployment,
    event: event.kind,
    trace_id: event.trace_id,
    // Present only for workspace-scoped events.
    ...(event.workspace_id ? { workspace_id: event.workspace_id } : {}),
    properties,
  };
}

export function toWireBatch(events: ExportEvent[]): WireBatch {
  return { schema: COLLECTOR_BATCH_SCHEMA, events: events.map(toWireEvent) };
}

/**
 * UTF-8 byte length of a string: `Buffer.byteLength(value, 'utf8')` on Node,
 * a `TextEncoder` count where `Buffer` is absent. Never `value.length`.
 */
export function utf8Bytes(value: string): number {
  const buffer = (globalThis as { Buffer?: { byteLength(v: string, enc: 'utf8'): number } }).Buffer;
  return buffer ? buffer.byteLength(value, 'utf8') : new TextEncoder().encode(value).byteLength;
}

/** Serialized UTF-8 bytes of one wire event (as it appears inside a batch body). */
export function wireEventBytes(event: ExportEvent): number {
  return utf8Bytes(JSON.stringify(toWireEvent(event)));
}

/**
 * Serialized UTF-8 bytes of a batch body with no events
 * (`{"schema":"agent-relay.analytics.batch/v1","events":[]}`). A body of n
 * events is exactly this plus the events' {@link wireEventBytes} plus n - 1
 * separating commas.
 */
export const WIRE_BATCH_FRAME_BYTES = utf8Bytes(JSON.stringify({ schema: COLLECTOR_BATCH_SCHEMA, events: [] }));

/** A failed collector request. The message is the content-free `reason`. */
export class CollectorExportError extends Error implements ExportFailureHint {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly split?: boolean;
  readonly configuration?: boolean;
  readonly reason: string;

  constructor(reason: string, init: { retryable: boolean; status?: number; retryAfterMs?: number; split?: boolean; configuration?: boolean }) {
    super(reason);
    this.name = 'CollectorExportError';
    this.reason = reason;
    this.retryable = init.retryable;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.split) this.split = true;
    if (init.configuration) this.configuration = true;
  }
}

/** Delta-seconds `Retry-After` in ms, capped; undefined for absent, HTTP-date or malformed values. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^[0-9]{1,10}$/.test(trimmed)) return undefined;
  return Math.min(Number(trimmed) * 1000, RETRY_DELAY_MAX_MS);
}

/** Classify any collector response other than 204. */
export function collectorResponseError(status: number, retryAfter: string | null): CollectorExportError {
  const delay = (): { retryAfterMs?: number } => {
    const ms = parseRetryAfter(retryAfter);
    return ms === undefined ? {} : { retryAfterMs: ms };
  };
  if (status >= 200 && status < 300) {
    // Only 204 acknowledges acceptance; another 2xx proves nothing was committed.
    return new CollectorExportError(`collector protocol error: ${status} is not an acceptance (204)`, { retryable: true, status });
  }
  if (status === 401 || status === 403) {
    return new CollectorExportError(`collector rejected producer credential (${status}); check the collector token and deployment id`, { retryable: false, status, configuration: true });
  }
  if (status === 413) {
    return new CollectorExportError('collector rejected an oversized batch (413)', { retryable: false, status, split: true });
  }
  if (status === 429) return new CollectorExportError('collector backpressure (429)', { retryable: true, status, ...delay() });
  if (status === 503) return new CollectorExportError('collector unavailable (503)', { retryable: true, status, ...delay() });
  if (status === 507) return new CollectorExportError('collector storage exhausted (507)', { retryable: true, status, ...delay() });
  if (status >= 300 && status < 400) {
    // Never followed; a redirect does not change on retry.
    return new CollectorExportError(`collector redirected (${status}); not followed`, { retryable: false, status });
  }
  if (status === 408) return new CollectorExportError('collector request timeout (408)', { retryable: true, status });
  if (status >= 400 && status < 500) {
    // 400 is an invalid batch/version/scope; other 4xx will not change on an unchanged retry either.
    return new CollectorExportError(`collector rejected batch (${status})`, { retryable: false, status });
  }
  return new CollectorExportError(`collector responded ${status}`, { retryable: true, status });
}

export interface HttpCollectorTransportOptions {
  /** Collector ingest URL (the full URL; no path is appended). */
  url: string;
  /** Per-producer bearer token for the collector (required). Never logged. */
  bearerToken: string;
  /**
   * Per-attempt request timeout. An attempt's `timeoutMs` from the batcher
   * (the remaining delivery or shutdown deadline) shortens it further.
   */
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export interface CollectorTransport {
  send(events: ExportEvent[], attempt?: BatchAttempt): Promise<void>;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True for hosts that may be reached over plaintext http (see file header). */
export function isPlaintextCollectorHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '127.0.0.1' || host === '[::1]') return true;
  if (host.endsWith('.svc') || host.endsWith('.svc.cluster.local')) {
    return host.split('.').every((label) => DNS_LABEL.test(label));
  }
  // A single DNS label, but not an all-numeric one (which a URL parser reads as an IPv4 address).
  return DNS_LABEL.test(host) && !/^[0-9]+$/.test(host);
}

/** Validate a collector URL; throws an Error naming the rule it broke. */
export function validateCollectorUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('telemetry collector URL must be a valid absolute URL');
  }
  if (url.username || url.password) {
    throw new Error('telemetry collector URL must not contain credentials; use the bearer token');
  }
  // `url.search`/`url.hash` are empty for a bare `?`/`#`, so check the input too.
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new Error('telemetry collector URL must not contain a query string or fragment; give the full endpoint URL, including /v1/events');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isPlaintextCollectorHost(url.hostname)) return url;
  if (url.protocol === 'http:') {
    throw new Error('telemetry collector URL must use https unless the host is localhost, 127.0.0.1, [::1], a *.svc / *.svc.cluster.local Service or a single-label hostname');
  }
  throw new Error('telemetry collector URL must use http or https');
}

export function createHttpCollectorTransport(options: HttpCollectorTransportOptions): CollectorTransport {
  const url = validateCollectorUrl(options.url).toString();
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('telemetry collector timeoutMs must be a positive integer');
  }
  if (typeof options.bearerToken !== 'string' || options.bearerToken.trim() === '') {
    throw new Error('telemetry collector bearerToken is required');
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${options.bearerToken}`,
  };
  const timeoutMs = options.timeoutMs;

  return {
    async send(events: ExportEvent[], attempt?: BatchAttempt): Promise<void> {
      if (events.length === 0) return;
      const limit = attempt?.timeoutMs;
      const attemptTimeoutMs = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.min(timeoutMs, Math.ceil(limit))
        : timeoutMs;
      const doFetch = options.fetch ?? globalThis.fetch;
      const body = JSON.stringify(toWireBatch(events));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
          // A redirect could point anywhere: never follow it (so the credential
          // is never forwarded); `manual` surfaces it as a 3xx to classify.
          redirect: 'manual',
        });
      } catch {
        // The error text is not logged: it can echo network details.
        throw new CollectorExportError(
          controller.signal.aborted ? 'collector request timed out' : 'collector connection failed',
          { retryable: true },
        );
      } finally {
        clearTimeout(timer);
      }
      // Release the connection; the body is never read.
      try { await response.body?.cancel(); } catch { /* ignore */ }
      if (response.type === 'opaqueredirect') {
        throw new CollectorExportError('collector redirected; not followed', { retryable: false });
      }
      if (response.status !== 204) {
        throw collectorResponseError(response.status, response.headers.get('retry-after'));
      }
    },
  };
}
