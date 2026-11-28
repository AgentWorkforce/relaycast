import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(
  data: unknown,
  apiOk = true,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () =>
      Promise.resolve(
        apiOk ? { ok: true, data } : { ok: false, error: data },
      ),
  });
}

describe('HttpClient retry policy', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  it('applies the expected default retry policy', () => {
    const client = new HttpClient({ apiKey: 'at_live_test123' });

    expect(client.retryPolicy).toEqual({
      maxRetries: 3,
      backoffMs: 1000,
      backoffMultiplier: 2,
      jitter: true,
      retryOn: [429, 500, 502, 503, 504],
    });
  });

  it('retries retriable status codes and eventually succeeds', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({
      apiKey: 'at_live_test123',
      retryPolicy: {
        maxRetries: 2,
        backoffMs: 10,
        backoffMultiplier: 2,
        jitter: false,
        retryOn: [500, 502],
      },
    });

    mockFetch
      .mockImplementationOnce(() =>
        mockResponse({ code: 'internal_error', message: 'boom' }, false, 500),
      )
      .mockImplementationOnce(() =>
        mockResponse({ code: 'internal_error', message: 'boom' }, false, 502),
      )
      .mockImplementationOnce(() => mockResponse({ id: 'ws_1' }, true, 200));

    const promise = client.get<{ id: string }>('/v1/workspace');

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    await expect(promise).resolves.toEqual({ id: 'ws_1' });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('uses Retry-After header delay for 429 responses', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({
      apiKey: 'at_live_test123',
      retryPolicy: {
        maxRetries: 1,
        backoffMs: 5,
        backoffMultiplier: 2,
        jitter: false,
        retryOn: [429],
      },
    });

    mockFetch
      .mockImplementationOnce(() =>
        mockResponse(
          { code: 'rate_limited', message: 'slow down' },
          false,
          429,
          { 'Retry-After': '2' },
        ),
      )
      .mockImplementationOnce(() => mockResponse({ id: 'ws_1' }));

    const promise = client.get<{ id: string }>('/v1/workspace');

    await vi.advanceTimersByTimeAsync(1999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ id: 'ws_1' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws transport_error after retries are exhausted on network failures', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({
      apiKey: 'at_live_test123',
      retryPolicy: {
        maxRetries: 2,
        backoffMs: 5,
        backoffMultiplier: 1,
        jitter: false,
      },
    });

    mockFetch.mockRejectedValue(new Error('socket hang up'));

    const promise = client.get('/v1/workspace');
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'RelayError',
      code: 'transport_error',
      status: 0,
    });

    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('times out a hung POST once and never replays it', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({ apiKey: 'at_live_test123', retryPolicy: { backoffMs: 5, jitter: false } });
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const promise = client.post('/v1/agents/heartbeat', {}, { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'RelayError',
      code: 'transport_error',
      message: 'Network request failed: Request timed out after 100ms',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const signal = (mockFetch.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(true);
  });

  it('gives each retryable attempt its own timeout', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({ apiKey: 'at_live_test123', retryPolicy: { backoffMs: 5, jitter: false } });
    mockFetch
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => mockResponse({ ok: 1 }));

    const promise = client.get('/v1/workspace', undefined, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(105);

    await expect(promise).resolves.toEqual({ ok: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('times out a response whose JSON body never arrives', async () => {
    vi.useFakeTimers();
    const client = new HttpClient({ apiKey: 'at_live_test123' });
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) });

    const promise = client.post('/v1/agents/heartbeat', {}, { timeoutMs: 100 });
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'transport_error',
      message: 'Network request failed: Request timed out after 100ms',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends no abort signal when no timeout is requested', async () => {
    const client = new HttpClient({ apiKey: 'at_live_test123' });
    mockFetch.mockImplementation(() => mockResponse({}));

    await client.post('/v1/agents/heartbeat', {});
    expect(mockFetch.mock.calls[0]![1]).not.toHaveProperty('signal');
  });
});
