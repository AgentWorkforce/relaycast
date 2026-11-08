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
  validateCollectorUrl,
} from '../httpTransport.js';

const event = projectException(new Error('x'), undefined, { deployment: 'd' });

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
    workspaceId: 'ws_1',
    authenticatedActor: { agentId: 'agent_1', credentialHash: 'HASH_POISON', type: 'agent' },
    sender: { id: 'agent_1', name: 'SENDER_POISON', type: 'agent' },
    origin: { actor: 'sdk', client: 'ts', version: '1.2.3' },
    facts: { channel_id: 'ch_1', message_id: 'msg_1', request_id: 'req_1', text: 'TEXT_POISON' },
  }, { deployment: 'acme', instance: 'relaycast-0' })!;

  it('maps an observation to the collector envelope', () => {
    expect(toWireEvent(observed)).toEqual({
      version: 1,
      event_id: observed.event_id,
      occurred_at: '2026-11-08T10:00:00.000Z',
      component: 'relaycast',
      deployment_id: 'acme',
      event: 'message.created',
      trace_id: 'req_1',
      workspace_id: 'ws_1',
      properties: {
        channel_id: 'ch_1',
        message_id: 'msg_1',
        actor_type: 'agent',
        origin_actor: 'sdk',
        origin_client: 'ts',
        origin_version: '1.2.3',
        instance: 'relaycast-0',
      },
    });
    const wire = JSON.stringify(toWireEvent(observed));
    for (const poison of ['HASH_POISON', 'SENDER_POISON', 'TEXT_POISON']) expect(wire).not.toContain(poison);
    expect(wire).not.toContain('tenant_id');
  });

  it('omits trace_id and workspace_id when absent and never sends tenant_id', () => {
    const wire = toWireEvent(event);
    expect(wire).not.toHaveProperty('trace_id');
    expect(wire).not.toHaveProperty('workspace_id');
    expect(wire).not.toHaveProperty('tenant_id');
    expect(wire).toMatchObject({ version: 1, event: 'exception', deployment_id: 'd', properties: { error_name: 'Error' } });
    expect(toWireEvent({ ...observed, workspace_id: '' })).not.toHaveProperty('workspace_id');
  });

  it('attributes a workspace exception by workspace_id only, never a tenant_id', () => {
    const wire = toWireEvent(projectException(new Error('x'), { workspace_id: 'ws_7' }, { deployment: 'd' }));
    expect(wire.workspace_id).toBe('ws_7');
    expect(wire).not.toHaveProperty('tenant_id');
    expect(Object.values(wire).filter((value) => value === 'ws_7')).toEqual(['ws_7']);
    expect(toWireEvent(observed)).not.toHaveProperty('tenant_id');
  });

  it('strips reserved field names from properties', () => {
    const facts: ExportEvent['facts'] = { ok: 1 };
    for (const name of COLLECTOR_RESERVED_FIELDS) facts[name] = 'OVERRIDE_POISON';
    const wire = toWireEvent({ ...observed, facts });
    expect(Object.keys(wire.properties).filter((key) => COLLECTOR_RESERVED_FIELDS.has(key))).toEqual([]);
    expect(wire.properties.ok).toBe(1);
    expect(JSON.stringify(wire)).not.toContain('OVERRIDE_POISON');
    expect(wire.event_id).toBe(observed.event_id);
    expect(wire.workspace_id).toBe('ws_1');
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
      [401, { retryable: false, reason: 'collector rejected producer credential (401)' }],
      [403, { retryable: false, reason: 'collector rejected producer credential (403)' }],
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

  it('omits authorization without a token and skips empty batches', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = createHttpCollectorTransport({ url: 'https://collector.example.com/ingest', timeoutMs: 1000, fetch });
    await transport.send([]);
    expect(fetch).not.toHaveBeenCalled();
    await transport.send([event]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('throws a typed, content-free error for a non-2xx response', async () => {
    const transport = (fetch: typeof globalThis.fetch) =>
      createHttpCollectorTransport({ url: 'http://collector/ingest', bearerToken: 'tok_SECRET', timeoutMs: 1000, fetch });
    const unavailable = await failure(transport(respond(503, { 'retry-after': '4' })).send([event]));
    expect(unavailable).toMatchObject({ retryable: true, status: 503, retryAfterMs: 4000 });
    const denied = await failure(transport(respond(401)).send([event]));
    expect(denied).toMatchObject({ retryable: false, status: 401, message: 'collector rejected producer credential (401)' });
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
      createHttpCollectorTransport({ url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
    await expect(transport(respond(204)).send([event])).resolves.toBeUndefined();
    for (const status of [200, 202, 206]) {
      const err = await failure(transport(respond(status)).send([event]));
      expect(err, String(status)).toMatchObject({ retryable: true, status });
      expect(err.message).not.toMatch(/SECRET_BODY_POISON/);
    }
  });

  it('treats a manual-redirect opaque response as a terminal redirect', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, body: null, headers: new Headers() } as unknown as Response;
    const transport = createHttpCollectorTransport({ url: 'http://collector/ingest', timeoutMs: 1000, fetch: vi.fn(async () => opaque) });
    expect(await failure(transport.send([event]))).toMatchObject({ retryable: false, message: 'collector redirected; not followed' });
  });

  it('turns a connection error into a retryable error without its text', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('fetch failed: getaddrinfo SECRET_HOST_DETAIL'); });
    const transport = createHttpCollectorTransport({ url: 'http://collector/ingest', timeoutMs: 1000, fetch });
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
    const transport = createHttpCollectorTransport({ url: 'http://localhost:4318/x', timeoutMs: 250, fetch: fetch as never });
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
    const transport = createHttpCollectorTransport({ url: 'http://localhost:4318/x', timeoutMs: 1000, fetch: fetch as never });
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
      expect(() => createHttpCollectorTransport({ url, timeoutMs: 1000 }), url).toThrow(/telemetry collector URL/);
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
      expect(() => createHttpCollectorTransport({ url, timeoutMs: 1000 }), url).toThrow(/query string or fragment/);
    }
    expect(() => validateCollectorUrl('not a url')).toThrow(/valid absolute URL/);
  });

  it('sends to the configured URL exactly, never appending /v1/events', async () => {
    const fetch = respond(204);
    await createHttpCollectorTransport({ url: 'http://collector:8080/v1/events', timeoutMs: 1000, fetch }).send([event]);
    await createHttpCollectorTransport({ url: 'http://collector:8080/custom/intake', timeoutMs: 1000, fetch }).send([event]);
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
    const transport = createHttpCollectorTransport({ url: 'http://collector/v1/events', timeoutMs: 1000, fetch });
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
