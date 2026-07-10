import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareTelemetry } from '../telemetry.js';
import { captureInternalTelemetryBatched } from '../../lib/telemetry.js';

vi.mock('../../lib/telemetry.js', () => ({
  captureInternalTelemetryBatched: vi.fn().mockResolvedValue(undefined),
}));

describe('createCloudflareTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lifts origin fields out of properties into the origin shape', () => {
    // origin_surface was dropped from the engine origin contract in 4.0 (#188),
    // so the engine no longer folds it into properties — there is nothing left to
    // strip. We just lift origin_client/origin_version back out.
    const env = { ENVIRONMENT: 'production' } as any;
    const sink = createCloudflareTelemetry(env);

    sink.capture({
      name: 'relaycast_server_search_executed',
      distinctId: 'ws_123',
      properties: {
        workspace_id: 'ws_123',
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      },
    });

    expect(captureInternalTelemetryBatched).toHaveBeenCalledTimes(1);
    expect(captureInternalTelemetryBatched).toHaveBeenCalledWith(env, {
      event: 'relaycast_server_search_executed',
      distinct_id: 'ws_123',
      origin: {
        origin_client: '@relaycast/sdk-ts',
        origin_version: '0.3.1',
      },
      properties: {
        workspace_id: 'ws_123',
      },
    });
  });

  it('tolerates missing engine event properties', () => {
    const env = { ENVIRONMENT: 'production' } as any;
    const sink = createCloudflareTelemetry(env);

    sink.capture({
      name: 'relaycast_server_search_executed',
      distinctId: 'ws_123',
      properties: undefined,
    } as any);

    expect(captureInternalTelemetryBatched).toHaveBeenCalledTimes(1);
    expect(captureInternalTelemetryBatched).toHaveBeenCalledWith(env, {
      event: 'relaycast_server_search_executed',
      distinct_id: 'ws_123',
      origin: {
        origin_client: undefined,
        origin_version: undefined,
      },
      properties: {},
    });
  });
});
