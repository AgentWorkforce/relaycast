import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../env.js';
import { emitServerEvent, normalizeRoutePathForTelemetry } from '../serverTelemetry.js';
import { HARNESS_HEADER } from '../origin.js';

vi.mock('../posthog.js', () => {
  const mockCapture = vi.fn();
  return {
    getPostHogClient: vi.fn(() => ({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    })),
    flushAllPostHogClients: vi.fn().mockResolvedValue(undefined),
    telemetryEnabled: vi.fn(() => true),
  };
});

describe('normalizeRoutePathForTelemetry', () => {
  it('strips query/hash and normalizes repeated slashes', () => {
    expect(normalizeRoutePathForTelemetry('v1//channels///general/messages?limit=10#x')).toBe('/v1/channels/general/messages');
  });

  it('normalizes numeric and UUID-like dynamic segments', () => {
    expect(normalizeRoutePathForTelemetry('/v1/messages/1234567890123/reactions')).toBe('/v1/messages/:id/reactions');
    expect(normalizeRoutePathForTelemetry('/v1/webhooks/550e8400-e29b-41d4-a716-446655440000')).toBe('/v1/webhooks/:id');
  });

  it('normalizes known prefixed ids', () => {
    expect(normalizeRoutePathForTelemetry('/v1/subscriptions/sub_abc123def456')).toBe('/v1/subscriptions/:id');
    expect(normalizeRoutePathForTelemetry('/v1/webhooks/wh_k3x9q2p7z1n4')).toBe('/v1/webhooks/:id');
  });
});

type CapturedCall = { distinctId: string; event: string; properties: Record<string, unknown> };

function fakeContext(opts: {
  headers?: Record<string, string>;
  vars?: Record<string, unknown>;
}): Context<AppEnv> {
  const headers = new Headers(opts.headers ?? {});
  const vars = new Map<string, unknown>(Object.entries(opts.vars ?? {}));
  const raw = new Request('https://example.com/v1/test', { headers });

  return {
    env: {
      ENVIRONMENT: 'development',
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com/',
    } as unknown as AppEnv['Bindings'],
    req: { raw },
    get: (key: string) => vars.get(key),
    set: (key: string, value: unknown) => {
      vars.set(key, value);
    },
  } as unknown as Context<AppEnv>;
}

async function lastCaptureCall(): Promise<CapturedCall> {
  // Allow the queued runInBackground microtask to drain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { getPostHogClient } = await import('../posthog.js');
  const clientMock = (getPostHogClient as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value as
    | { capture: ReturnType<typeof vi.fn> }
    | undefined;
  if (!clientMock) throw new Error('PostHog client was not constructed');
  const call = clientMock.capture.mock.calls.at(-1);
  if (!call) throw new Error('capture was not called');
  return call[0] as CapturedCall;
}

describe('emitServerEvent — harness stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stamps the harness from the request context variable', async () => {
    const c = fakeContext({ vars: { harness: 'claude-code' } });
    emitServerEvent(c, 'ws_123', 'relaycast_server_search_executed', {
      query_length: 4,
      result_count: 1,
    });
    const call = await lastCaptureCall();
    expect(call.properties.harness).toBe('claude-code');
    expect(call.properties.workspace_id).toBe('ws_123');
  });

  it('falls back to reading the header when the context variable is missing', async () => {
    const c = fakeContext({ headers: { [HARNESS_HEADER]: 'cursor' } });
    emitServerEvent(c, 'ws_123', 'relaycast_server_search_executed', {
      query_length: 4,
      result_count: 1,
    });
    const call = await lastCaptureCall();
    expect(call.properties.harness).toBe('cursor');
  });

  it('defaults to "unknown" when neither context nor header is present', async () => {
    const c = fakeContext({});
    emitServerEvent(c, 'ws_123', 'relaycast_server_search_executed', {
      query_length: 4,
      result_count: 1,
    });
    const call = await lastCaptureCall();
    expect(call.properties.harness).toBe('unknown');
  });
});
