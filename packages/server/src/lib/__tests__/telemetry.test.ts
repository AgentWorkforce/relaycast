import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInternalTelemetryEvent,
  captureInternalTelemetry,
  captureInternalTelemetryBatched,
  workspaceDistinctId,
} from '../telemetry.js';

// Mock the posthog module
vi.mock('../posthog.js', () => {
  const mockCapture = vi.fn();
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  return {
    getPostHogClient: vi.fn(() => ({
      capture: mockCapture,
      shutdown: mockShutdown,
    })),
    flushAllPostHogClients: vi.fn().mockResolvedValue(undefined),
    telemetryEnabled: vi.fn(() => true),
  };
});

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

  it('sends capture events to PostHog via the SDK', async () => {
    const { getPostHogClient } = await import('../posthog.js');
    const mockCapture = vi.fn();
    (getPostHogClient as ReturnType<typeof vi.fn>).mockReturnValue({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

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

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: workspaceDistinctId('ws_123'),
      event: 'relaycast_server_search_executed',
      properties: expect.objectContaining({
        workspace_id: 'ws_123',
        origin_surface: 'sdk',
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      }),
    });
  });

  it('is a no-op when POSTHOG_API_KEY is missing', async () => {
    const { getPostHogClient } = await import('../posthog.js');
    const mockCapture = vi.fn();
    (getPostHogClient as ReturnType<typeof vi.fn>).mockReturnValue({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

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

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('is a no-op when opt-out env vars are enabled', async () => {
    const { getPostHogClient, telemetryEnabled } = await import('../posthog.js');
    const mockCapture = vi.fn();
    (getPostHogClient as ReturnType<typeof vi.fn>).mockReturnValue({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    (telemetryEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);

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

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does not auto-disable based on ENVIRONMENT name', async () => {
    const { getPostHogClient, telemetryEnabled } = await import('../posthog.js');
    const mockCapture = vi.fn();
    (getPostHogClient as ReturnType<typeof vi.fn>).mockReturnValue({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    (telemetryEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);

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

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('captureInternalTelemetryBatched delegates to the SDK (which handles batching internally)', async () => {
    const { getPostHogClient } = await import('../posthog.js');
    const mockCapture = vi.fn();
    (getPostHogClient as ReturnType<typeof vi.fn>).mockReturnValue({
      capture: mockCapture,
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    const p1 = captureInternalTelemetryBatched(
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
          query_length: 2,
          result_count: 1,
        },
      },
    );
    const p2 = captureInternalTelemetryBatched(
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
          query_length: 4,
          result_count: 2,
        },
      },
    );

    await Promise.all([p1, p2]);

    // SDK handles batching internally — we just verify both events were captured
    expect(mockCapture).toHaveBeenCalledTimes(2);
  });
});
