import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBatcher, RETRY_DELAY_MAX_MS, type BatcherOptions } from '../batcher.js';
import { projectException, projectObservation, type ExportEvent } from '../exportEnvelope.js';
import {
  COLLECTOR_BATCH_SCHEMA,
  COLLECTOR_RESERVED_FIELDS,
  CollectorExportError,
  collectorResponseError,
  createHttpCollectorTransport,
  parseRetryAfter,
  toWireEvent,
  utf8Bytes,
  validateCollectorUrl,
  WIRE_BATCH_FRAME_BYTES,
  wireEventBytes,
} from '../httpTransport.js';

/** A native engine workspace id (64-bit snowflake). */
const WS_1 = '1189827393826947072';

const TOKEN = 'tok_test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const event = projectException(new Error('x'), { request_id: 'req-exc-1' }, { deployment: 'd' })!;

async function failure(promise: Promise<unknown>): Promise<CollectorExportError> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(CollectorExportError);
  return err as CollectorExportError;
}

function respond(status: number, headers: Record<string, string> = {}) {
  return vi.fn(async () => new Response(status === 204 || status === 304 ? null : 'SECRET_BODY_POISON', { status, headers }));
}

describe('toWireEvent', () => {
  const observed = projectObservation({
    kind: 'message.created',
    occurredAt: '2026-11-08T10:00:00.000Z',
    workspaceId: WS_1,
    authenticatedActor: { agentId: 'agent_1', credentialHash: 'HASH_POISON', type: 'agent' },
    sender: { id: 'agent_1', name: 'SENDER_POISON', type: 'agent' },
    origin: { actor: 'agent-relay-cli/agent/ORIGIN_NAME_POISON', client: '@relaycast/sdk', version: '1.2.3-VERSION_POISON' },
    traceId: 'req_1',
    facts: { channel_id: '1001', message_id: '2002', request_id: 'req_1', text: 'TEXT_POISON' },
  }, { deployment: 'acme' })!;

  it('maps an observation to the collector envelope', () => {
    expect(toWireEvent(observed)).toEqual({
      version: 1,
      event_id: observed.event_id,
      occurred_at: '2026-11-08T10:00:00.000Z',
      component: 'relaycast',
      deployment_id: 'acme',
      event: 'message.created',
      trace_id: 'req_1',
      workspace_id: WS_1,
      properties: {
        channel_id: '1001',
        message_id: '2002',
        actor_type: 'agent',
        origin_app: 'agent-relay-cli',
        origin_actor_type: 'agent',
        origin_client: '@relaycast/sdk',
      },
    });
    const wire = JSON.stringify(toWireEvent(observed));
    for (const poison of ['HASH_POISON', 'SENDER_POISON', 'TEXT_POISON', 'ORIGIN_NAME_POISON', 'VERSION_POISON']) expect(wire).not.toContain(poison);
    expect(wire).not.toContain('tenant_id');
    expect(wire).not.toContain('instance');
  });

  it('always sends a trace_id, omits workspace_id when absent and never sends tenant_id', () => {
    const wire = toWireEvent(event);
    expect(wire.trace_id).toBe('req-exc-1');
    expect(wire).not.toHaveProperty('workspace_id');
    expect(wire).not.toHaveProperty('tenant_id');
    expect(wire).toMatchObject({ version: 1, event: 'exception', deployment_id: 'd', properties: { error_name: 'Error' } });
    expect(toWireEvent({ ...observed, workspace_id: '' })).not.toHaveProperty('workspace_id');
  });

  it('F4: attributes an exception (installation-only) without workspace_id or tenant_id, whatever the context says', () => {
    const wire = toWireEvent(projectException(new Error('x'), { workspace_id: 'ws_7', request_id: 'req-7' }, { deployment: 'd' })!);
    expect(wire).not.toHaveProperty('workspace_id');
    expect(wire).not.toHaveProperty('tenant_id');
    expect(JSON.stringify(wire)).not.toContain('ws_7');
    expect(toWireEvent(observed)).not.toHaveProperty('tenant_id');
    expect(toWireEvent(observed).workspace_id).toBe(WS_1);
  });

  it('strips reserved field names from properties', () => {
    const facts: ExportEvent['facts'] = { channel_id: '1001' };
    for (const name of COLLECTOR_RESERVED_FIELDS) facts[name] = 'OVERRIDE_POISON';
    const wire = toWireEvent({ ...observed, facts });
    expect(Object.keys(wire.properties).filter((key) => COLLECTOR_RESERVED_FIELDS.has(key))).toEqual([]);
    expect(wire.properties.channel_id).toBe('1001');
    expect(JSON.stringify(wire)).not.toContain('OVERRIDE_POISON');
    expect(wire.event_id).toBe(observed.event_id);
    expect(wire.workspace_id).toBe(WS_1);
  });
});

describe('parseRetryAfter', () => {
  it('accepts bounded delta-seconds only', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter(' 7 ')).toBe(7000);
    expect(parseRetryAfter('3600')).toBe(30_000);
    expect(parseRetryAfter('999999')).toBe(RETRY_DELAY_MAX_MS);
    expect(parseRetryAfter('99999999999')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('+5')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter('5s')).toBeUndefined();
    expect(parseRetryAfter('0x10')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
  });
});

describe('collectorResponseError', () => {
  it('classifies statuses per the collector contract', () => {
    const cases: Array<[number, Partial<CollectorExportError>]> = [
      [400, { retryable: false }],
      [401, { retryable: false, configuration: true }],
      [403, { retryable: false, configuration: true }],
      [404, { retryable: false }],
      [408, { retryable: true }],
      [413, { retryable: false, split: true }],
      [429, { retryable: true }],
      [500, { retryable: true }],
      [502, { retryable: true }],
      [503, { retryable: true }],
      [507, { retryable: true, reason: 'collector storage exhausted (507)' }],
      [302, { retryable: false }],
      [200, { retryable: true }],
      [202, { retryable: true }],
      [206, { retryable: true }],
    ];
    for (const [status, expected] of cases) {
      const err = collectorResponseError(status, null);
      expect(err, String(status)).toMatchObject({ status, ...expected });
      expect(err.message).toBe(err.reason);
      expect(err.message).toContain(String(status));
    }
    expect(collectorResponseError(400, null).split).toBeUndefined();
    expect(collectorResponseError(400, null).configuration).toBeUndefined();
    expect(collectorResponseError(401, null).reason).toBe('collector rejected producer credential (401); check the collector token and deployment id');
    expect(collectorResponseError(503, null).configuration).toBeUndefined();
    for (const status of [200, 201, 202, 206]) {
      expect(collectorResponseError(status, '5')).toMatchObject({
        status,
        retryable: true,
        reason: `collector protocol error: ${status} is not an acceptance (204)`,
      });
      expect(collectorResponseError(status, '5').retryAfterMs).toBeUndefined();
    }
  });

  it('honors Retry-After only on 429, 503 and 507', () => {
    expect(collectorResponseError(429, '5').retryAfterMs).toBe(5000);
    expect(collectorResponseError(503, '120').retryAfterMs).toBe(30_000);
    expect(collectorResponseError(507, '2').retryAfterMs).toBe(2000);
    expect(collectorResponseError(503, 'Wed, 21 Oct 2026 07:28:00 GMT').retryAfterMs).toBeUndefined();
    expect(collectorResponseError(500, '5').retryAfterMs).toBeUndefined();
    expect(collectorResponseError(400, '5').retryAfterMs).toBeUndefined();
  });
});

afterEach(() => { vi.useRealTimers(); });

describe('createHttpCollectorTransport', () => {
  it('POSTs { schema, events } as JSON with the bearer token', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createHttpCollectorTransport({ url: 'http://collector.analytics.svc:8080/v1/events', bearerToken: 'tok_test', timeoutMs: 1000, fetch });
    await transport.send([event]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://collector.analytics.svc:8080/v1/events');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok_test' });
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({ schema: COLLECTOR_BATCH_SCHEMA, events: [toWireEvent(event)] });
    expect(COLLECTOR_BATCH_SCHEMA).toBe('agent-relay.analytics.batch/v1');
  });

  it('requires a bearer token and skips empty batches', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    for (const bearerToken of [undefined, '', '   ']) {
      expect(() => createHttpCollectorTransport({ url: 'https://collector.example.com/ingest', timeoutMs: 1000, fetch, bearerToken } as never))
        .toThrow('telemetry collector bearerToken is required');
    }
    const transport = createHttpCollectorTransport({ url: 'https://collector.example.com/ingest', bearerToken: 'tok_x', timeoutMs: 1000, fetch });
    await transport.send([]);
    expect(fetch).not.toHaveBeenCalled();
    await transport.send([event]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer tok_x' });
  });

  it('throws a typed, content-free error for a non-2xx response', async () => {
    const transport = (fetch: typeof globalThis.fetch) =>
      createHttpCollectorTransport({ url: 'http://collector/ingest', bearerToken: 'tok_SECRET', timeoutMs: 1000, fetch });
    const unavailable = await failure(transport(respond(503, { 'retry-after': '4' })).send([event]));
    expect(unavailable).toMatchObject({ retryable: true, status: 503, retryAfterMs: 4000 });
    const denied = await failure(transport(respond(401)).send([event]));
    expect(denied).toMatchObject({ retryable: false, status: 401, configuration: true, message: 'collector rejected producer credential (401); check the collector token and deployment id' });
    const tooLarge = await failure(transport(respond(413)).send([event]));
    expect(tooLarge).toMatchObject({ retryable: false, split: true });
    const redirected = await failure(transport(respond(307, { location: 'https://elsewhere.example.com/' })).send([event]));
    expect(redirected).toMatchObject({ retryable: false, status: 307 });
    for (const err of [unavailable, denied, tooLarge, redirected]) {
      expect(`${err.message} ${err.stack}`).not.toMatch(/SECRET/);
    }
  });

  it('accepts only 204; any other 2xx is a retryable protocol error', async () => {
    const transport = (fetch: typeof globalThis.fetch) =>
      createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    await expect(transport(respond(204)).send([event])).resolves.toBeUndefined();
    for (const status of [200, 202, 206]) {
      const err = await failure(transport(respond(status)).send([event]));
      expect(err, String(status)).toMatchObject({ retryable: true, status });
      expect(err.message).not.toMatch(/SECRET_BODY_POISON/);
    }
  });

  it('treats a manual-redirect opaque response as a terminal redirect', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, body: null, headers: new Headers() } as unknown as Response;
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/ingest', timeoutMs: 1000, fetch: vi.fn(async () => opaque) });
    expect(await failure(transport.send([event]))).toMatchObject({ retryable: false, message: 'collector redirected; not followed' });
  });

  it('turns a connection error into a retryable error without its text', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed: getaddrinfo SECRET_HOST_DETAIL'); });
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/ingest', timeoutMs: 1000, fetch });
    const err = await failure(transport.send([event]));
    expect(err).toMatchObject({ retryable: true, message: 'collector connection failed' });
    expect(err.status).toBeUndefined();
  });

  it('aborts a request that exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://localhost:4318/x', timeoutMs: 250, fetch: fetch as never });
    const sent = transport.send([event]);
    const settled = expect(sent).rejects.toMatchObject({ retryable: true, message: 'collector request timed out' });
    await vi.advanceTimersByTimeAsync(250);
    await settled;
    expect(signal?.aborted).toBe(true);
  });

  it('shortens the abort to the per-attempt timeout the batcher passes, never lengthens it', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://localhost:4318/x', timeoutMs: 1000, fetch: fetch as never });
    const short = expect(transport.send([event], { timeoutMs: 120 })).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(119);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await short;
    expect(signals[0]!.aborted).toBe(true);
    const long = expect(transport.send([event], { timeoutMs: 5000 })).rejects.toMatchObject({ retryable: true });
    await vi.advanceTimersByTimeAsync(1000);
    await long;
    expect(signals[1]!.aborted).toBe(true);
  });

  it('requires https except for loopback, in-cluster Service and single-label hosts', () => {
    for (const url of ['http://example.com/x', 'http://collector.example.svc.evil.com/', 'http://10.0.0.5/', 'http://0x0a000005/', 'ftp://collector/']) {
      expect(() => createHttpCollectorTransport({ bearerToken: TOKEN, url, timeoutMs: 1000 }), url).toThrow(/telemetry collector URL/);
    }
    for (const url of [
      'https://anything.example.com/ingest',
      'http://collector.analytics.svc/',
      'http://collector.analytics.svc.cluster.local:8080/v1',
      'http://collector:8080/',
      'http://localhost:4318/',
      'http://127.0.0.1:4318/',
      'http://[::1]:4318/',
    ]) {
      expect(() => validateCollectorUrl(url), url).not.toThrow();
    }
    expect(() => validateCollectorUrl('https://user:pass@collector.example.com/')).toThrow(/credentials/);
    for (const url of [
      'http://collector:8080/v1/events?token=x',
      'http://collector:8080/v1/events?',
      'https://collector.example.com/v1/events#frag',
      'https://collector.example.com/v1/events#',
    ]) {
      expect(() => validateCollectorUrl(url), url).toThrow(/query string or fragment/);
      expect(() => createHttpCollectorTransport({ bearerToken: TOKEN, url, timeoutMs: 1000 }), url).toThrow(/query string or fragment/);
    }
    expect(() => validateCollectorUrl('not a url')).toThrow(/valid absolute URL/);
  });

  it('sends to the configured URL exactly, never appending /v1/events', async () => {
    const fetch = respond(204);
    await createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector:8080/v1/events', timeoutMs: 1000, fetch }).send([event]);
    await createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector:8080/custom/intake', timeoutMs: 1000, fetch }).send([event]);
    expect(fetch.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      'http://collector:8080/v1/events',
      'http://collector:8080/custom/intake',
    ]);
  });
});

describe('collector transport with the batcher', () => {
  const opts: BatcherOptions = { queueMax: 10, batchMax: 10, flushIntervalMs: 0, maxAttempts: 3, backoffMs: 100, shutdownTimeoutMs: 60_000 };

  function setup(statuses: (call: number) => [number, Record<string, string>?], overrides: Partial<BatcherOptions> = {}) {
    const fetch = vi.fn(async () => {
      const [status, headers] = statuses(fetch.mock.calls.length);
      return new Response(status === 204 ? null : 'SECRET_BODY_POISON', { status, headers });
    });
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    const batcher = createBatcher<ExportEvent>(transport, { ...opts, ...overrides }, { log: () => {} });
    return { fetch, batcher };
  }

  it.each([200, 202, 206])('retries a %i within maxAttempts, then counts the loss', async (status) => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup(() => [status]);
    batcher.enqueue(event);
    batcher.enqueue(event);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(opts.maxAttempts);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 2, rejected: 0, failedBatches: 1, retries: opts.maxAttempts - 1 });
  });

  it('counts a 204 as accepted', async () => {
    const { fetch, batcher } = setup(() => [204]);
    batcher.enqueue(event);
    await batcher.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 1, dropped: 0, retries: 0 });
  });

  it.each([
    ['malformed', 'soon'],
    ['an HTTP-date', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['zero', '0'],
  ])('falls back to the local backoff for a %s Retry-After', async (_label, value) => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup((call) => (call === 1 ? [429, { 'retry-after': value }] : [204]));
    batcher.enqueue(event);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batcher.stats()).toMatchObject({ exported: 1, retries: 1 });
  });

  it('never makes more than maxAttempts attempts on a zero Retry-After', async () => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup(() => [503, { 'retry-after': '0' }], { backoffMs: 0 });
    batcher.enqueue(event);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(opts.maxAttempts);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 1, failedBatches: 1 });
  });

  it('caps an oversized Retry-After at 30 s', async () => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup((call) => (call === 1 ? [503, { 'retry-after': '999999' }] : [204]));
    batcher.enqueue(event);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MAX_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batcher.stats()).toMatchObject({ exported: 1, retries: 1 });
  });

  it('drops a batch waiting on Retry-After at the shutdown deadline', async () => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup(() => [429, { 'retry-after': '30' }], { shutdownTimeoutMs: 2000, batchMax: 1 });
    batcher.enqueue(event);
    batcher.enqueue(event);
    let done = false;
    void batcher.shutdown().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    // Counted at the deadline: the waiting batch and the one queued behind it.
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 2, failedBatches: 1, queued: 0 });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MAX_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ dropped: 2, failedBatches: 1 });
  });

  it('drops a batch whose Retry-After would outlast the delivery deadline', async () => {
    vi.useFakeTimers();
    const { fetch, batcher } = setup(() => [503, { 'retry-after': '20' }], { deliveryDeadlineMs: 10_000 });
    batcher.enqueue(event);
    await batcher.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 1, expired: 1, retries: 0 });
  });
});

describe('collector contract responses through the batcher', () => {
  const opts: BatcherOptions<ExportEvent> = {
    queueMax: 100, batchMax: 100, flushIntervalMs: 0, maxAttempts: 3, backoffMs: 100, shutdownTimeoutMs: 60_000,
    sizeOf: wireEventBytes, batchFrameBytes: WIRE_BATCH_FRAME_BYTES,
  };
  type Call = { url: string; init: RequestInit; events: Array<{ event_id: string; trace_id: string }> };

  function harness(reply: (call: Call, index: number) => [number, Record<string, string>?], overrides: Partial<BatcherOptions<ExportEvent>> = {}) {
    const calls: Call[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init, events: (JSON.parse(init.body as string) as { events: Call['events'] }).events };
      calls.push(call);
      const [status, headers] = reply(call, calls.length);
      return new Response(status === 204 ? null : 'SECRET_BODY_POISON', { status, headers });
    });
    const log = vi.fn();
    const transport = createHttpCollectorTransport({ url: 'http://collector/v1/events', bearerToken: 'tok_SECRET', timeoutMs: 1000, fetch: fetch as never });
    const batcher = createBatcher<ExportEvent>(transport, { ...opts, ...overrides }, { log });
    return { calls, fetch, log, batcher };
  }

  const events = (n: number) => Array.from({ length: n }, (_, i) => projectException(new Error('x'), { request_id: `req-${i}` }, { deployment: 'd' })!);
  const observations = (n: number, workspaceId: (i: number) => string) => Array.from({ length: n }, (_, i) => projectObservation({
    kind: 'message.created',
    occurredAt: '2026-11-08T10:00:00.000Z',
    workspaceId: workspaceId(i),
    traceId: `req-${i}`,
    facts: { channel_id: '1001', message_id: String(2000 + i) },
  }, { deployment: 'd' })!);

  it.each([301, 302, 303, 307, 308])('does not follow or retry a %i redirect, never re-sending the token', async (status) => {
    vi.useFakeTimers();
    const { calls, log, batcher } = harness(() => [status, { location: 'https://attacker.example.com/steal' }]);
    for (const e of events(2)) batcher.enqueue(e);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://collector/v1/events');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 2, rejected: 2, failedBatches: 1, retries: 0, configFailures: 0 });
    expect(log.mock.calls[0]![0]).toMatch(new RegExp(`redirected \\(${status}\\); not followed`));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|attacker/);
  });

  it.each([401, 403])('treats %i as a terminal configuration failure: counted and logged, not retried', async (status) => {
    vi.useFakeTimers();
    const { calls, log, batcher } = harness(() => [status, { 'www-authenticate': 'Bearer' }]);
    for (const e of events(3)) batcher.enqueue(e);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(calls).toHaveLength(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 3, rejected: 3, configFailures: 1, failedBatches: 1, retries: 0 });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(new RegExp(`CONFIGURATION FAILURE: rejected a batch of 3; not retried \\(collector rejected producer credential \\(${status}\\); check the collector token and deployment id`));
    expect(log.mock.calls[0]![0]).toMatch(/configFailures=1/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET/);
  });

  it('treats 400 as terminal and counts the rejected events', async () => {
    vi.useFakeTimers();
    const { calls, log, batcher } = harness(() => [400]);
    for (const e of events(5)) batcher.enqueue(e);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(calls).toHaveLength(1);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 5, rejected: 5, failedBatches: 1, retries: 0, configFailures: 0 });
    expect(log.mock.calls[0]![0]).toMatch(/collector rejected batch \(400\).*rejected=5/);
  });

  it('splits a 413 batch boundedly and drops/counts the single event still refused as oversized', async () => {
    const all = events(4);
    const tooBig = all[2]!.event_id;
    const { calls, batcher } = harness((call) => [call.events.some((e) => e.event_id === tooBig) ? 413 : 204]);
    for (const e of all) batcher.enqueue(e);
    await batcher.flush();
    // [0..3] 413 -> [0,1] 204, [2,3] 413 -> [2] 413 (dropped), [3] 204
    expect(calls.map((call) => call.events.length)).toEqual([4, 2, 2, 1, 1]);
    expect(batcher.stats()).toMatchObject({ exported: 3, dropped: 1, oversized: 1, rejected: 1, splits: 2, retries: 0 });
    expect(calls.length).toBeLessThanOrEqual(2 * all.length - 1);
  });

  it('drops an event over eventMaxBytes (UTF-8) before sending and counts it as oversized', async () => {
    // Workspace-scoped observations: only those carry a workspace_id.
    const [small] = observations(1, () => WS_1);
    const huge: ExportEvent = { ...small!, event_id: globalThis.crypto.randomUUID(), workspace_id: '中'.repeat(120) };
    const ascii: ExportEvent = { ...small!, event_id: globalThis.crypto.randomUUID() };
    // The CJK workspace id is 120 code units but 360 bytes (measured before any
    // validation); the valid snowflake one is 19 bytes.
    const eventMaxBytes = wireEventBytes(ascii) + 150;
    expect(JSON.stringify(toWireEvent(huge)).length).toBeLessThan(eventMaxBytes);
    expect(wireEventBytes(huge)).toBeGreaterThan(eventMaxBytes);
    const { calls, batcher } = harness(() => [204], { eventMaxBytes, batchMaxBytes: 64 * 1024, queueMaxBytes: 64 * 1024 });
    batcher.enqueue(huge);
    batcher.enqueue(ascii);
    await batcher.flush();
    expect(calls.flatMap((call) => call.events.map((e) => e.event_id))).toEqual([ascii.event_id]);
    expect(batcher.stats()).toMatchObject({ exported: 1, dropped: 1, oversized: 1 });
  });

  it('retries 507 within the budget, honoring Retry-After, then counts the loss', async () => {
    vi.useFakeTimers();
    const recovering = harness((_call, n) => (n === 1 ? [507, { 'retry-after': '2' }] : [204]));
    recovering.batcher.enqueue(events(1)[0]!);
    const flushed = recovering.batcher.flush();
    await vi.advanceTimersByTimeAsync(1999);
    expect(recovering.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(recovering.calls).toHaveLength(2);
    expect(recovering.batcher.stats()).toMatchObject({ exported: 1, retries: 1 });

    const exhausted = harness(() => [507]);
    for (const e of events(2)) exhausted.batcher.enqueue(e);
    const lost = exhausted.batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await lost;
    expect(exhausted.calls).toHaveLength(opts.maxAttempts);
    expect(exhausted.batcher.stats()).toMatchObject({ exported: 0, dropped: 2, rejected: 0, failedBatches: 1, retries: opts.maxAttempts - 1 });
    expect(exhausted.log.mock.calls[0]![0]).toMatch(/storage exhausted \(507\)/);
  });

  it('keeps event_id and trace_id stable across retries and splits', async () => {
    vi.useFakeTimers();
    const all = events(4);
    const splitTarget = all[3]!.event_id;
    const { calls, batcher } = harness((call, n) => {
      if (n === 1) return [503];
      return [call.events.length > 1 && call.events.some((e) => e.event_id === splitTarget) ? 413 : 204];
    });
    for (const e of all) batcher.enqueue(e);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(batcher.stats()).toMatchObject({ exported: 4, retries: 1, splits: 2 });
    const expected = new Map(all.map((e) => [e.event_id, e.trace_id]));
    expect(all.map((e) => e.trace_id)).toEqual(['req-0', 'req-1', 'req-2', 'req-3']);
    let seen = 0;
    for (const call of calls) {
      for (const wire of call.events) {
        expect(wire.trace_id).toBe(expected.get(wire.event_id));
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(all.length);
  });

  it('accounts batch bytes exactly: frame + events + separators, in UTF-8', async () => {
    expect(WIRE_BATCH_FRAME_BYTES).toBe(55);
    expect(utf8Bytes(JSON.stringify({ schema: COLLECTOR_BATCH_SCHEMA, events: [] }))).toBe(55);
    expect(utf8Bytes('é中\u{1F600}')).toBe(9);
    const all = observations(3, (i) => String(1189827393826947072n + BigInt(i) * 1_000_003n));
    const { calls, batcher } = harness(() => [204]);
    for (const e of all) batcher.enqueue(e);
    await batcher.flush();
    const body = calls[0]!.init.body as string;
    const sum = all.reduce((total, e) => total + wireEventBytes(e), 0);
    expect(utf8Bytes(body)).toBe(WIRE_BATCH_FRAME_BYTES + sum + all.length - 1);
    for (const e of all) expect(wireEventBytes(e)).toBe(utf8Bytes(JSON.stringify(toWireEvent(e))));
  });

  it('forms batches within batchMaxBytes of the real wire body', async () => {
    const all = events(10);
    const each = wireEventBytes(all[0]!);
    const batchMaxBytes = WIRE_BATCH_FRAME_BYTES + 3 * each + 2 + 5; // room for 3 events, not 4
    const { calls, batcher } = harness(() => [204], { eventMaxBytes: each + 10, batchMaxBytes, queueMaxBytes: 64 * 1024 });
    for (const e of all) batcher.enqueue(e);
    await batcher.flush();
    expect(calls.map((call) => call.events.length)).toEqual([3, 3, 3, 1]);
    for (const call of calls) expect(utf8Bytes(call.init.body as string)).toBeLessThanOrEqual(batchMaxBytes);
  });
});

describe('review repairs (#636): wire allowlist, classification, acceptance, ids, auth header', () => {
  const identity = { deployment: 'd' };
  const observationEvent = (facts: ExportEvent['facts']): ExportEvent => ({
    ...projectObservation({ kind: 'agent.updated', occurredAt: '2026-11-08T10:00:00.000Z', workspaceId: WS_1, traceId: 'req-1', facts: {} }, identity)!,
    facts,
  });

  it('F1: toWireEvent never exports agent_name or other product facts, even on a hand-built event', () => {
    const wire = toWireEvent(observationEvent({
      agent_name: 'alice-the-agent',
      sender_name: 'bob-sender',
      channel_name: 'secret-launch',
      content: 'PRODUCT_CONTENT_POISON',
      text: 'PRODUCT_TEXT_POISON',
      changed_status: true,
    }));
    expect(wire.properties.changed_status).toBe(true);
    expect(Object.keys(wire.properties).sort()).toEqual(['changed_status', 'origin_actor_type', 'origin_app', 'origin_client']);
    const json = JSON.stringify(wire);
    for (const leak of ['alice-the-agent', 'bob-sender', 'secret-launch', 'PRODUCT_CONTENT_POISON', 'PRODUCT_TEXT_POISON', 'agent_name', 'channel_name']) {
      expect(json).not.toContain(leak);
    }
  });

  it('F2: toWireEvent maps arbitrary exception names, codes and operations to the fixed classification', () => {
    const base = projectException(new Error('x'), { request_id: 'req-2' }, identity)!;
    const wire = toWireEvent({
      ...base,
      facts: { error_name: 'AcmeVendorError', error_code: 'ACME_CUSTOMER_42', operation: 'billing.charge_alice', message: 'MESSAGE_POISON', stack: 'STACK_POISON' },
    });
    expect(wire.properties).toEqual({ error_name: 'unregistered' });
    const json = JSON.stringify(wire);
    for (const leak of ['AcmeVendorError', 'ACME_CUSTOMER_42', 'billing.charge_alice', 'MESSAGE_POISON', 'STACK_POISON']) expect(json).not.toContain(leak);
    // Registered values still pass.
    expect(toWireEvent({ ...base, facts: { error_name: 'TypeError', error_code: 'SQLITE_BUSY', operation: 'inbox.get' } }).properties)
      .toEqual({ error_name: 'TypeError', error_code: 'SQLITE_BUSY', operation: 'inbox.get' });
  });

  function batched(status: number, overrides: Partial<BatcherOptions> = {}) {
    const fetch = vi.fn(async () => new Response(status === 204 ? null : 'BODY', { status }));
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    const batcher = createBatcher<ExportEvent>(transport, { queueMax: 10, batchMax: 10, flushIntervalMs: 0, maxAttempts: 3, backoffMs: 100, shutdownTimeoutMs: 60_000, ...overrides }, { log: () => {} });
    return { fetch, batcher };
  }

  it.each([200, 202, 206])('F3: a %i is a counted protocol error, never an acceptance, and its events are lost after the budget', async (status) => {
    vi.useFakeTimers();
    const { fetch, batcher } = batched(status);
    batcher.enqueue(event);
    batcher.enqueue(event);
    const flushed = batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(batcher.stats()).toMatchObject({ exported: 0, dropped: 2, failedBatches: 1, protocolErrors: 3, queued: 0, inFlight: 0 });
  });

  it('F3: 507 is counted as a storage failure and a redirect as a redirect, never as acceptance', async () => {
    vi.useFakeTimers();
    const storage = batched(507);
    storage.batcher.enqueue(event);
    const flushedStorage = storage.batcher.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushedStorage;
    expect(storage.batcher.stats()).toMatchObject({ exported: 0, dropped: 1, storageFailures: 3 });
    const redirect = batched(307);
    redirect.batcher.enqueue(event);
    await redirect.batcher.flush();
    expect(redirect.fetch).toHaveBeenCalledTimes(1);
    expect(redirect.batcher.stats()).toMatchObject({ exported: 0, dropped: 1, redirects: 1 });
  });

  it('F4: the transport refuses a batch with an event missing trace_id or carrying tenant_id, without sending it', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    const { trace_id: _omit, ...noTrace } = event;
    for (const bad of [
      noTrace as ExportEvent,
      { ...event, trace_id: '' },
      { ...event, tenant_id: 'tenant_1' } as ExportEvent,
      { ...observationEvent({}), workspace_id: null },
      { ...event, workspace_id: 'ws_substituted' },
    ]) {
      const err = await failure(transport.send([event, bad]));
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/^invalid export event \((missing_trace_id|tenant_id_not_allowed|missing_workspace_id|unauthorized_workspace_id)\); not sent$/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('F5 (guard, already held on 48a20866): sends exactly one Authorization: Bearer header and never puts the token in the body or URL', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createHttpCollectorTransport({ bearerToken: 'tok_SECRET_VALUE', url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    await transport.send([event]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    const authNames = Object.keys(init.headers as Record<string, string>).filter((name) => name.toLowerCase() === 'authorization');
    expect(authNames).toHaveLength(1);
    expect(headers.get('authorization')).toBe('Bearer tok_SECRET_VALUE');
    expect(String(init.body)).not.toContain('tok_SECRET_VALUE');
    expect(url).not.toContain('tok_SECRET_VALUE');
  });
});

describe('review repairs (#636 re-review): shutdown abort reaches the request (F10)', () => {
  function hangingFetch() {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signals.push(init.signal!);
      // Like a real fetch: an already-aborted signal rejects at once.
      if (init.signal!.aborted) reject(new DOMException('aborted', 'AbortError'));
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    return { fetch, signals };
  }

  it("F10: the transport aborts its fetch when the batcher's attempt signal is aborted", async () => {
    const { fetch, signals } = hangingFetch();
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/ingest', timeoutMs: 60_000, fetch: fetch as never });
    const attempt = new AbortController();
    const sent = transport.send([event], { timeoutMs: 60_000, signal: attempt.signal });
    const settled = expect(sent).rejects.toMatchObject({ retryable: true });
    await Promise.resolve();
    expect(signals[0]!.aborted).toBe(false);
    attempt.abort();
    await settled;
    await expect(sent).rejects.toMatchObject({ message: 'collector request cancelled' });
    expect(signals[0]!.aborted).toBe(true);
  });

  it('F10: an attempt signal aborted before send starts aborts the fetch immediately', async () => {
    const { fetch, signals } = hangingFetch();
    const transport = createHttpCollectorTransport({ bearerToken: TOKEN, url: 'http://collector/ingest', timeoutMs: 60_000, fetch: fetch as never });
    const attempt = new AbortController();
    attempt.abort();
    await expect(transport.send([event], { timeoutMs: 60_000, signal: attempt.signal })).rejects.toMatchObject({ retryable: true });
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
