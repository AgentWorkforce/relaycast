import { describe, expect, it } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../env.js';
import { emitServerEvent } from '../serverTelemetry.js';

type CapturedEvent = Parameters<AppEnv['Variables']['engine']['telemetry']['capture']>[0];

function contextFor(
  request: Request,
  capture: (event: CapturedEvent) => void,
): Context<AppEnv> {
  return {
    req: { raw: request },
    get(key: keyof AppEnv['Variables']) {
      if (key === 'engine') {
        return { telemetry: { capture } };
      }
      if (key === 'harness') {
        return undefined;
      }
      return undefined;
    },
  } as unknown as Context<AppEnv>;
}

describe('emitServerEvent', () => {
  it('uses a valid client anonymous id as the distinct id and preserves workspace id', () => {
    const captured: CapturedEvent[] = [];
    const request = new Request('https://gateway.relaycast.dev/v1/messages', {
      headers: {
        'X-Agent-Relay-Anonymous-Id': 'anon-123',
        'X-Relaycast-Origin-Surface': 'sdk',
        'X-Relaycast-Origin-Client': '@relaycast/sdk',
        'X-Relaycast-Origin-Version': '2.4.0',
      },
    });

    emitServerEvent(
      contextFor(request, (event) => captured.push(event)),
      'ws_123',
      'relaycast_server_message_created',
      { route_path: '/v1/messages/msg_123456789' },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      name: 'relaycast_server_message_created',
      distinctId: 'anon-123',
      properties: {
        app: 'relaycast-server',
        surface: 'cloud',
        workspace_id: 'ws_123',
        client_anonymous_id: 'anon-123',
        harness: 'unknown',
        origin_surface: 'sdk',
        origin_client: '@relaycast/sdk',
        origin_version: '2.4.0',
        route_path: '/v1/messages/msg_123456789',
      },
    });
  });

  it('falls back to workspace id when the client anonymous id is malformed', () => {
    const captured: CapturedEvent[] = [];
    const request = new Request('https://gateway.relaycast.dev/v1/messages', {
      headers: {
        'X-Agent-Relay-Anonymous-Id': 'bad<script>',
      },
    });

    emitServerEvent(
      contextFor(request, (event) => captured.push(event)),
      'ws_123',
      'relaycast_server_message_created',
      {},
    );

    expect(captured[0]?.distinctId).toBe('ws_123');
    expect(captured[0]?.properties).not.toHaveProperty('client_anonymous_id');
  });
});
