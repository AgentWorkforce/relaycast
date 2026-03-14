import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpWorkspaceConfig } from '../workspaces.js';

vi.mock('@relaycast/sdk/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relaycast/sdk/internal')>();
  return {
    ...actual,
    createInternalWsClient: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnValue(() => {}),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  };
});

import { createRelayMcpServer } from '../server.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

describe('multi-agent integration routing', () => {
  let client: Client;
  let captured: CapturedRequest[];
  let originalFetch: typeof global.fetch;

  const workspaces: McpWorkspaceConfig[] = [
    {
      workspace_id: 'ws_alpha',
      workspace_alias: 'alpha',
      api_key: 'rk_live_alpha',
      agent_token: 'at_alpha',
      agent_name: 'AlphaBot',
    },
    {
      workspace_id: 'ws_beta',
      workspace_alias: 'beta',
      api_key: 'rk_live_beta',
      agent_token: 'at_beta',
      agent_name: 'BetaBot',
    },
  ];

  beforeEach(async () => {
    captured = [];
    originalFetch = global.fetch;

    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const request: CapturedRequest = {
        url: url.toString(),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: Object.fromEntries(
          Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
        ),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      captured.push(request);

      const path = new URL(url.toString()).pathname;

      if (path.match(/\/v1\/channels\/[^/]+\/messages$/) && request.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            id: 'msg_beta',
            text: (request.body as { text?: string } | undefined)?.text ?? null,
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (path === '/v1/workspace') {
        const auth = request.headers.authorization;
        const data = {
          name: auth === 'Bearer rk_live_beta' ? 'Beta Workspace' : 'Alpha Workspace',
        };

        return new Response(JSON.stringify({ ok: true, data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (path === '/v1/agents' && request.method === 'POST') {
        const name = (request.body as { name?: string } | undefined)?.name ?? 'UnknownAgent';
        const token = name === 'BetaWriter' ? 'at_beta_writer' : 'at_generated';

        return new Response(JSON.stringify({
          ok: true,
          data: {
            id: `agent_${name}`,
            name,
            token,
            status: 'online',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (path === '/v1/inbox') {
        const auth = request.headers.authorization;
        const data = auth === 'Bearer at_beta_writer'
          ? {
              unread_channels: [{ channel_name: 'beta-writer', unread_count: 4 }],
              mentions: [],
              unread_dms: [],
              recent_reactions: [],
            }
          : auth === 'Bearer at_beta'
            ? {
              unread_channels: [{ channel_name: 'beta', unread_count: 2 }],
              mentions: [],
              unread_dms: [],
              recent_reactions: [],
            }
            : {
              unread_channels: [],
              mentions: [],
              unread_dms: [],
              recent_reactions: [],
              };

        return new Response(JSON.stringify({ ok: true, data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof global.fetch;

    const mcpServer = createRelayMcpServer({
      apiKey: 'rk_live_alpha',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      baseUrl: 'https://api.test.dev',
      workspaces,
    });

    client = new Client({ name: 'multi-agent-integration-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses the routed workspace for both message dispatch and piggyback inbox fetch', async () => {
    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta',
        workspace_id: 'ws_beta',
      },
    });

    expect(result.isError).toBeFalsy();

    const postRequest = captured.find((request) =>
      request.method === 'POST' && request.url.endsWith('/v1/channels/general/messages'));
    const inboxRequest = captured.find((request) =>
      request.method === 'GET' && request.url.endsWith('/v1/inbox'));

    expect(postRequest).toBeDefined();
    expect(postRequest?.headers.authorization).toBe('Bearer at_beta');
    expect(inboxRequest).toBeDefined();
    expect(inboxRequest?.headers.authorization).toBe('Bearer at_beta');
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta: 2 unread');
  });

  it('uses the requested routed agent identity for both message dispatch and piggyback inbox fetches', async () => {
    await client.callTool({
      name: 'workspace.switch',
      arguments: {
        api_key: 'rk_live_beta',
      },
    });

    const registerResult = await client.callTool({
      name: 'agent.register',
      arguments: {
        name: 'BetaWriter',
      },
    });

    expect(registerResult.isError).toBeFalsy();

    await client.callTool({
      name: 'workspace.switch',
      arguments: {
        api_key: 'rk_live_alpha',
      },
    });

    captured = [];

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta writer',
        workspace_id: 'ws_beta',
        as: 'BetaWriter',
      },
    });

    expect(result.isError).toBeFalsy();

    const postRequest = captured.find((request) =>
      request.method === 'POST' && request.url.endsWith('/v1/channels/general/messages'));
    const inboxRequest = captured.find((request) =>
      request.method === 'GET' && request.url.endsWith('/v1/inbox'));

    expect(postRequest).toBeDefined();
    expect(postRequest?.headers.authorization).toBe('Bearer at_beta_writer');
    expect(inboxRequest).toBeDefined();
    expect(inboxRequest?.headers.authorization).toBe('Bearer at_beta_writer');
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta-writer: 4 unread');
  });
});
