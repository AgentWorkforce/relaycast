import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { AppEnv } from '../../env.js';
import { emitServerEvent } from '../serverTelemetry.js';

function contextFor(request: Request, capture = vi.fn()): Context<AppEnv> {
  return {
    req: { raw: request },
    get: (key: string) => {
      if (key === 'engine') {
        return {
          telemetry: {
            capture,
            captureException: vi.fn(),
          },
        };
      }
      if (key === 'harness') return 'mcp';
      return undefined;
    },
  } as unknown as Context<AppEnv>;
}

describe('emitServerEvent', () => {
  it('uses a sanitized Agent Relay anonymous id as distinctId when present', () => {
    const capture = vi.fn();
    const request = new Request('https://gateway.relaycast.dev/v1/messages', {
      headers: {
        'X-Agent-Relay-Anonymous-Id': 'anon-123',
      },
    });

    emitServerEvent(
      contextFor(request, capture),
      'ws_123',
      'relaycast_server_message_created',
      {
        channel_id: 'ch_123',
        message_id: 'msg_123',
      },
    );

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'anon-123',
      properties: expect.objectContaining({
        client_anonymous_id: 'anon-123',
        workspace_id: 'ws_123',
      }),
    }));
  });

  it('falls back to workspace id when the Agent Relay anonymous id is malformed', () => {
    const capture = vi.fn();
    const request = new Request('https://gateway.relaycast.dev/v1/messages', {
      headers: {
        'X-Agent-Relay-Anonymous-Id': 'anon<script>',
      },
    });

    emitServerEvent(
      contextFor(request, capture),
      'ws_123',
      'relaycast_server_message_created',
      {
        channel_id: 'ch_123',
        message_id: 'msg_123',
      },
    );

    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      distinctId: 'ws_123',
      properties: expect.not.objectContaining({
        client_anonymous_id: expect.anything(),
      }),
    }));
  });
});
