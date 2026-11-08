import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import { emitServerEvent } from '../../lib/serverTelemetry.js';
import { safeTelemetrySink, type EngineObservation, type TelemetrySink } from '../../ports/telemetry.js';
import { createNodeRuntime } from '../../adapters/node/index.js';
import type { ExportEvent } from '../../telemetry/exportEnvelope.js';
import { CollectorConfigError, CollectorTelemetrySink, COLLECTOR_TELEMETRY_DEFAULTS, createCollectorTelemetrySink } from '../collector-telemetry.js';

const quietLocal: TelemetrySink = { capture: () => {}, captureException: () => {} };

function observation(): EngineObservation {
  return {
    kind: 'message.created',
    occurredAt: '2026-11-08T10:00:00.000Z',
    workspaceId: 'ws_1',
    authenticatedActor: { agentId: 'agent_1', credentialHash: 'HASH_POISON', type: 'agent' },
    sender: { id: 'agent_1', name: 'SENDER_POISON', type: 'agent' },
    origin: { actor: 'sdk', client: 'ts', version: '1' },
    facts: { channel_id: '1001', message_id: '2002', text: 'TEXT_POISON' },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CollectorTelemetrySink', () => {
  it('exports projected observations and exceptions in batches', async () => {
    const sent: ExportEvent[][] = [];
    const sink = createCollectorTelemetrySink({
      url: 'http://collector/ingest', bearerToken: 'tok_test', deployment: 'acme', local: quietLocal,
      transport: { send: async (events) => { sent.push(events); } },
    });
    sink.capture(observation());
    sink.captureException(new Error('MESSAGE_POISON'), { source: 'node.maintenance', op: 'node_delivery' });
    await sink.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((e) => e.kind)).toEqual(['message.created', 'exception']);
    const wire = JSON.stringify(sent);
    for (const poison of ['HASH_POISON', 'SENDER_POISON', 'TEXT_POISON', 'MESSAGE_POISON']) expect(wire).not.toContain(poison);
    expect(sink.stats()).toMatchObject({ enqueued: 2, exported: 2, dropped: 0 });
  });

  it('keeps the product path synchronous and unaffected when the collector always fails', async () => {
    const send = vi.fn(async () => { throw new Error('collector down'); });
    const local = { capture: vi.fn(), captureException: vi.fn() };
    const log = vi.fn();
    const sink = new CollectorTelemetrySink({
      url: 'http://collector/ingest', bearerToken: 'tok_test', deployment: 'acme', local,
      transport: { send }, maxAttempts: 2, backoffMs: 1, batchMax: 1, batcherDeps: { log },
    });
    const app = new Hono<AppEnv>();
    app.use(async (c, next) => {
      c.set('engine', { telemetry: safeTelemetrySink(sink) } as never);
      await next();
    });
    app.post('/', (c) => {
      emitServerEvent(c, 'ws_1', 'message.created', { channel_id: '1001', message_id: '2002' });
      return c.json({ ok: true }, 201);
    });
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(201);
    expect((await response.json()).ok).toBe(true);
    expect(sink.capture(observation())).toBeUndefined();
    await sink.flush();
    expect(send).toHaveBeenCalled();
    expect(sink.stats()).toMatchObject({ failedBatches: 2, exported: 0 });
    // Failures go to the rate-limited log only, never back into a sink.
    expect(local.captureException).not.toHaveBeenCalled();
    expect(local.capture).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('retries over HTTP with identical event_id values and honors Retry-After', async () => {
    vi.useFakeTimers();
    const bodies: Array<{ schema: string; events: Array<{ event_id: string }> }> = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1
        ? new Response('busy', { status: 503, headers: { 'retry-after': '2' } })
        : new Response(null, { status: 204 });
    });
    const sink = new CollectorTelemetrySink({
      url: 'http://collector.analytics.svc/v1/events', bearerToken: 'tok_test', deployment: 'acme', local: quietLocal,
      fetch: fetch as never, backoffMs: 10, batcherDeps: { log: () => {} },
    });
    sink.capture(observation());
    sink.captureException(new Error('boom'));
    const flushed = sink.flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(2);
    const ids = bodies.map((body) => body.events.map((e) => e.event_id));
    expect(ids[0]).toHaveLength(2);
    expect(ids[1]).toEqual(ids[0]);
    expect(sink.stats()).toMatchObject({ exported: 2, retries: 1, dropped: 0 });
  });

  it('drops a batch the collector rejects as unauthorized and logs a configuration failure without the token', async () => {
    const fetch = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    const log = vi.fn();
    const sink = new CollectorTelemetrySink({
      url: 'http://collector.analytics.svc/v1/events', bearerToken: 'tok_SECRET', deployment: 'acme', local: quietLocal,
      fetch: fetch as never, batcherDeps: { log },
    });
    sink.capture(observation());
    await sink.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sink.stats()).toMatchObject({ exported: 0, dropped: 1, rejected: 1, retries: 0, configFailures: 1 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('CONFIGURATION FAILURE');
    expect(log.mock.calls[0]![0]).toContain('collector rejected producer credential (401)');
    expect(log.mock.calls[0]![0]).not.toMatch(/SECRET|unauthorized"/);
  });

  it('does not throw for malformed input', () => {
    const sink = createCollectorTelemetrySink({ url: 'http://collector/', bearerToken: 'tok_test', deployment: 'acme', local: quietLocal, transport: { send: async () => {} } });
    expect(() => sink.capture(null as never)).not.toThrow();
    expect(() => sink.captureException(undefined, null as never)).not.toThrow();
  });

  it('refuses a public plaintext URL', () => {
    expect(() => createCollectorTelemetrySink({ url: 'http://example.com/', bearerToken: 'tok_test', deployment: 'acme' })).toThrow(/https/);
  });

  function configError(options: Record<string, unknown>): CollectorConfigError {
    let caught: unknown;
    try {
      createCollectorTelemetrySink({ url: 'https://c.example.com/v1/events', local: quietLocal, ...options } as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CollectorConfigError);
    return caught as CollectorConfigError;
  }

  it('requires a bearer token when enabled: missing_telemetry_collector_token', () => {
    for (const bearerToken of [undefined, '', '  ']) {
      expect(configError({ bearerToken, deployment: 'acme' })).toMatchObject({ code: 'missing_telemetry_collector_token', name: 'CollectorConfigError' });
    }
    // Even with an injected transport: the token requirement is configuration, not transport.
    expect(configError({ deployment: 'acme', transport: { send: async () => {} } }).code).toBe('missing_telemetry_collector_token');
  });

  it('requires an explicit deployment id when enabled, with no hostname fallback: missing_telemetry_collector_deployment_id', () => {
    for (const deployment of [undefined, '', '   ']) {
      expect(configError({ bearerToken: 'tok_test', deployment }).code).toBe('missing_telemetry_collector_deployment_id');
    }
    expect(configError({ bearerToken: 'tok_test', transport: { send: async () => {} } }).code).toBe('missing_telemetry_collector_deployment_id');
  });

  it('refuses a malformed deployment id: invalid_telemetry_collector_deployment_id', () => {
    for (const deployment of [' acme', 'acme prod', '-acme', 'a'.repeat(129), 'acme/prod', 'd\u00e9ploy']) {
      expect(configError({ bearerToken: 'tok_test', deployment }).code, deployment).toBe('invalid_telemetry_collector_deployment_id');
    }
    for (const deployment of ['acme', 'acme-prod.eu:1', 'a'.repeat(128), '0']) {
      expect(() => createCollectorTelemetrySink({ url: 'https://c.example.com/', bearerToken: 'tok_test', deployment, local: quietLocal }), deployment).not.toThrow();
    }
  });

  it('passes byte bounds through to the batcher with documented defaults', async () => {
    expect(COLLECTOR_TELEMETRY_DEFAULTS).toMatchObject({ eventMaxBytes: 8192, batchMaxBytes: 262_144, queueMaxBytes: 1_048_576 });
    const sent: ExportEvent[][] = [];
    const sink = createCollectorTelemetrySink({
      url: 'http://collector/ingest', bearerToken: 'tok_test', deployment: 'acme', local: quietLocal,
      eventMaxBytes: 200, batchMaxBytes: 1024, queueMaxBytes: 1024,
      transport: { send: async (events) => { sent.push(events); } },
      batcherDeps: { log: () => {} },
    });
    sink.capture(observation()); // a projected message.created event is larger than 200 bytes on the wire
    await sink.close();
    expect(sent).toEqual([]);
    expect(sink.stats()).toMatchObject({ enqueued: 0, dropped: 1, oversized: 1 });
    expect(() => createCollectorTelemetrySink({
      url: 'http://collector/ingest', bearerToken: 'tok_test', deployment: 'acme', eventMaxBytes: 1000, batchMaxBytes: 1000,
    })).toThrow(/batchMaxBytes/);
  });
});

describe('createNodeRuntime telemetryCollector', () => {
  it('exports through the collector and drains on closeTelemetry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const runtime = createNodeRuntime({
      dbPath: ':memory:', baseUrl: 'http://localhost:0', config: { environment: 'test' },
      telemetryCollector: { url: 'http://collector.analytics.svc/v1/events', deployment: 'acme', bearerToken: 'tok_test' },
    });
    runtime.deps.telemetry.capture(observation());
    runtime.close();
    await runtime.closeTelemetry();
    const collectorCalls = fetch.mock.calls.filter((call) => String((call as unknown[])[0]).startsWith('http://collector.analytics.svc'));
    expect(collectorCalls).toHaveLength(1);
    const body = JSON.parse((collectorCalls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.schema).toBe('agent-relay.analytics.batch/v1');
    expect(body.events[0]).toMatchObject({ version: 1, event: 'message.created', deployment_id: 'acme', workspace_id: 'ws_1' });
    expect(typeof body.events[0].trace_id).toBe('string');
    expect(body.events[0].trace_id.length).toBeGreaterThan(0);
    expect(body.events[0].properties).not.toHaveProperty('instance');
  });

  it('lets an explicit telemetry sink win', async () => {
    const capture = vi.fn();
    const runtime = createNodeRuntime({
      dbPath: ':memory:', baseUrl: 'http://localhost:0', config: { environment: 'test' },
      telemetry: { capture, captureException: () => {} },
      telemetryCollector: { url: 'http://example.com/', bearerToken: 'tok_test', deployment: 'acme' },
    });
    runtime.deps.telemetry.capture(observation());
    expect(capture).toHaveBeenCalledTimes(1);
    runtime.close();
    await expect(runtime.closeTelemetry()).resolves.toBeUndefined();
  });

  it('refuses a bad collector URL at construction', () => {
    expect(() => createNodeRuntime({
      dbPath: ':memory:', baseUrl: 'http://localhost:0', config: { environment: 'test' },
      telemetryCollector: { url: 'http://example.com/', bearerToken: 'tok_test', deployment: 'acme' },
    })).toThrow(/https/);
  });

  it('refuses a collector without a token or deployment id, never falling back to the hostname', () => {
    const runtime = (telemetryCollector: Record<string, unknown>) => () => createNodeRuntime({
      dbPath: ':memory:', baseUrl: 'http://localhost:0', config: { environment: 'test' },
      telemetryCollector: { url: 'http://collector.analytics.svc/v1/events', ...telemetryCollector } as never,
    });
    expect(runtime({ deployment: 'acme' })).toThrow(expect.objectContaining({ code: 'missing_telemetry_collector_token' }));
    expect(runtime({ bearerToken: 'tok_test' })).toThrow(expect.objectContaining({ code: 'missing_telemetry_collector_deployment_id' }));
  });
});
