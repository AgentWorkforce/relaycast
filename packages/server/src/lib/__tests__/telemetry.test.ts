import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInternalTelemetryEvent,
  captureInternalTelemetry,
  captureInternalTelemetryBatched,
  flushInternalTelemetryBatchesForTests,
  workspaceDistinctId,
} from '../telemetry.js';

describe('server telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enforces required server-event properties', () => {
    expect(() => buildInternalTelemetryEvent({
      event: 'relaycast_server_search_executed',
      distinct_id: workspaceDistinctId('ws_123'),
      origin: {
        origin_surface: 'sdk',
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      },
      properties: {
        workspace_id: 'ws_123',
      },
    })).toThrow(/Missing required properties/);
  });

  it('sends capture events to PostHog with origin in properties', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await captureInternalTelemetry(
      {
        ENVIRONMENT: 'production',
        POSTHOG_API_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com/',
      } as any,
      {
        event: 'relaycast_server_search_executed',
        distinct_id: workspaceDistinctId('ws_123'),
        origin: {
          origin_surface: 'sdk',
          origin_client: '@relaycast/sdk-ts',
          origin_version: '0.3.1',
        },
        properties: {
          workspace_id: 'ws_123',
          query_length: 6,
          result_count: 2,
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/capture/');
    expect(init.method).toBe('POST');

    const payload = JSON.parse(String(init.body));
    expect(payload.event).toBe('relaycast_server_search_executed');
    expect(payload.properties.origin_surface).toBe('sdk');
    expect(payload.properties.origin_client).toBe('@relaycast/sdk-ts');
    expect(payload.properties.origin_version).toBe('0.3.1');
  });

  it('is a no-op when POSTHOG_API_KEY is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await captureInternalTelemetry(
      {
        ENVIRONMENT: 'production',
      } as any,
      {
        event: 'relaycast_server_search_executed',
        distinct_id: workspaceDistinctId('ws_123'),
        origin: {
          origin_surface: 'sdk',
          origin_client: '@relaycast/sdk-ts',
          origin_version: '0.3.1',
        },
        properties: {
          workspace_id: 'ws_123',
          query_length: 1,
          result_count: 0,
        },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when opt-out env vars are enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await captureInternalTelemetry(
      {
        ENVIRONMENT: 'production',
        RELAYCAST_TELEMETRY_DISABLED: 'true',
        POSTHOG_API_KEY: 'phc_test',
      } as any,
      {
        event: 'relaycast_server_search_executed',
        distinct_id: workspaceDistinctId('ws_123'),
        origin: {
          origin_surface: 'sdk',
          origin_client: '@relaycast/sdk-ts',
          origin_version: '0.3.1',
        },
        properties: {
          workspace_id: 'ws_123',
          query_length: 1,
          result_count: 0,
        },
      },
    );

    await captureInternalTelemetryBatched(
      {
        ENVIRONMENT: 'production',
        DO_NOT_TRACK: '1',
        POSTHOG_API_KEY: 'phc_test',
      } as any,
      {
        event: 'relaycast_server_search_executed',
        distinct_id: workspaceDistinctId('ws_123'),
        origin: {
          origin_surface: 'sdk',
          origin_client: '@relaycast/sdk-ts',
          origin_version: '0.3.1',
        },
        properties: {
          workspace_id: 'ws_123',
          query_length: 2,
          result_count: 1,
        },
      },
    );

    await flushInternalTelemetryBatchesForTests();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not auto-disable based on ENVIRONMENT name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await captureInternalTelemetry(
      {
        ENVIRONMENT: 'staging',
        POSTHOG_API_KEY: 'phc_test',
      } as any,
      {
        event: 'relaycast_server_search_executed',
        distinct_id: workspaceDistinctId('ws_123'),
        origin: {
          origin_surface: 'sdk',
          origin_client: '@relaycast/sdk-ts',
          origin_version: '0.3.1',
        },
        properties: {
          workspace_id: 'ws_123',
          query_length: 3,
          result_count: 1,
        },
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('batches multiple events into one /batch request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ENVIRONMENT: 'production',
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com/',
    } as any;

    const p1 = captureInternalTelemetryBatched(env, {
      event: 'relaycast_server_search_executed',
      distinct_id: workspaceDistinctId('ws_123'),
      origin: {
        origin_surface: 'sdk',
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      },
      properties: {
        workspace_id: 'ws_123',
        query_length: 2,
        result_count: 1,
      },
    });
    const p2 = captureInternalTelemetryBatched(env, {
      event: 'relaycast_server_search_executed',
      distinct_id: workspaceDistinctId('ws_123'),
      origin: {
        origin_surface: 'sdk',
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      },
      properties: {
        workspace_id: 'ws_123',
        query_length: 4,
        result_count: 2,
      },
    });

    await flushInternalTelemetryBatchesForTests();
    await Promise.all([p1, p2]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/batch/');
    expect(init.method).toBe('POST');

    const payload = JSON.parse(String(init.body));
    expect(Array.isArray(payload.batch)).toBe(true);
    expect(payload.batch).toHaveLength(2);
  });
});
