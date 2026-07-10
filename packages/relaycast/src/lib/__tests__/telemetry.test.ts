import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInternalTelemetryEvent,
  captureInternalTelemetry,
  captureInternalTelemetryBatched,
  deriveOriginActorProps,
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

describe('deriveOriginActorProps', () => {
  it('splits {app}/{type}/{name}@{version}-{model} into dimensions', () => {
    expect(deriveOriginActorProps('agent-relay-cli/agent/claude-code@2.3.1-opus4.8')).toEqual({
      origin_app: 'agent-relay-cli',
      origin_actor_type: 'agent',
      origin_actor_name: 'claude-code',
      origin_actor_version: '2.3.1',
      origin_actor_model: 'opus4.8',
    });
  });

  it('splits version/model on the FIRST dash (model may contain dashes)', () => {
    expect(deriveOriginActorProps('agent-relay-cli/agent/codex@0.40-gpt-5')).toMatchObject({
      origin_actor_version: '0.40',
      origin_actor_model: 'gpt-5',
    });
  });

  it('handles name with no version/model', () => {
    expect(deriveOriginActorProps('agent-relay-cli/agent/claude-code')).toEqual({
      origin_app: 'agent-relay-cli',
      origin_actor_type: 'agent',
      origin_actor_name: 'claude-code',
    });
  });

  it('treats a meta without a leading digit as model-only (no version)', () => {
    expect(deriveOriginActorProps('agent-relay-cli/agent/claude-code@opus4.8')).toEqual({
      origin_app: 'agent-relay-cli',
      origin_actor_type: 'agent',
      origin_actor_name: 'claude-code',
      origin_actor_model: 'opus4.8',
    });
    // model with dashes, still model-only
    expect(deriveOriginActorProps('agent-relay-cli/agent/codex@gpt-5')).toMatchObject({
      origin_actor_name: 'codex',
      origin_actor_model: 'gpt-5',
    });
    expect(
      deriveOriginActorProps('agent-relay-cli/agent/codex@gpt-5').origin_actor_version,
    ).toBeUndefined();
  });

  it('treats a leading-digit meta with no dash as version-only', () => {
    expect(deriveOriginActorProps('agent-relay-cli/agent/claude-code@2.3.1')).toMatchObject({
      origin_actor_name: 'claude-code',
      origin_actor_version: '2.3.1',
    });
    expect(
      deriveOriginActorProps('agent-relay-cli/agent/claude-code@2.3.1').origin_actor_model,
    ).toBeUndefined();
  });

  it('handles the 2-segment form (no name)', () => {
    expect(deriveOriginActorProps('agent-relay-cli/cli')).toEqual({
      origin_app: 'agent-relay-cli',
      origin_actor_type: 'cli',
    });
  });

  it('handles a bare unknown', () => {
    expect(deriveOriginActorProps('unknown')).toEqual({ origin_app: 'unknown' });
  });

  it('returns {} for empty / non-string', () => {
    expect(deriveOriginActorProps('')).toEqual({});
    expect(deriveOriginActorProps(undefined)).toEqual({});
    expect(deriveOriginActorProps(42)).toEqual({});
  });
});
