import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { enablePiggyback } from '../piggyback.js';
import type { SessionState } from '../types.js';

describe('multi-agent piggyback routing', () => {
  let mcpServer: McpServer;
  let client: Client;
  let session: SessionState;
  let activeInbox: ReturnType<typeof vi.fn>;
  let betaInbox: ReturnType<typeof vi.fn>;
  let betaWriterInbox: ReturnType<typeof vi.fn>;
  let getAgentClient: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    activeInbox = vi.fn();
    betaInbox = vi.fn();
    betaWriterInbox = vi.fn();
    getAgentClient = vi.fn((wsRouting?: { workspace_id?: string; workspace_alias?: string }, asAgent?: string) => {
      if (asAgent === 'BetaWriter') {
        return { inbox: betaWriterInbox };
      }
      if (wsRouting?.workspace_id === 'ws_beta' || wsRouting?.workspace_alias === 'beta') {
        return { inbox: betaInbox };
      }
      return { inbox: activeInbox };
    });

    session = {
      workspaceKey: 'rk_live_alpha',
      agentToken: 'at_alpha',
      agentName: 'AlphaBot',
      agents: new Map([['AlphaBot', { agentName: 'AlphaBot', agentToken: 'at_alpha' }]]),
      wsBridge: null,
      subscriptions: null,
      wsInitAttempted: false,
      workspaces: new Map(),
    };

    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    enablePiggyback(mcpServer, () => session, getAgentClient as any);

    mcpServer.registerTool(
      'message.post',
      {
        description: 'Routed tool for piggyback coverage',
        inputSchema: {
          channel: z.string(),
          text: z.string(),
          workspace_id: z.string().optional(),
          workspace_alias: z.string().optional(),
          as: z.string().optional(),
        },
      },
      async () => ({
        content: [{ type: 'text' as const, text: 'original result' }],
      }),
    );

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('fetches piggyback inbox from the routed workspace_id context', async () => {
    betaInbox.mockResolvedValue({
      unreadChannels: [{ channelName: 'beta', unreadCount: 2 }],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    activeInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta',
        workspace_id: 'ws_beta',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({
      workspace_id: 'ws_beta',
      workspace_alias: undefined,
    }, undefined);
    expect(betaInbox).toHaveBeenCalledTimes(1);
    expect(activeInbox).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta: 2 unread');
  });

  it('fetches piggyback inbox from the routed workspace_alias context', async () => {
    betaInbox.mockResolvedValue({
      unreadChannels: [{ channelName: 'beta-alias', unreadCount: 1 }],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    activeInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta alias',
        workspace_alias: 'beta',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({
      workspace_id: undefined,
      workspace_alias: 'beta',
    }, undefined);
    expect(betaInbox).toHaveBeenCalledTimes(1);
    expect(activeInbox).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta-alias: 1 unread');
  });

  it('passes routed workspace and requested as identity to piggyback inbox fetches', async () => {
    betaWriterInbox.mockResolvedValue({
      unreadChannels: [{ channelName: 'beta-writer', unreadCount: 3 }],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    betaInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    activeInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta writer',
        workspace_alias: 'beta',
        as: 'BetaWriter',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({
      workspace_id: undefined,
      workspace_alias: 'beta',
    }, 'BetaWriter');
    expect(betaWriterInbox).toHaveBeenCalledTimes(1);
    expect(betaInbox).not.toHaveBeenCalled();
    expect(activeInbox).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta-writer: 3 unread');
  });

  it('still piggybacks routed inbox state when the active session token is missing', async () => {
    session.agentToken = null;
    session.agentName = null;

    betaWriterInbox.mockResolvedValue({
      unreadChannels: [{ channelName: 'beta-fallback', unreadCount: 4 }],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    betaInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });
    activeInbox.mockResolvedValue({
      unreadChannels: [],
      mentions: [],
      unreadDms: [],
      recentReactions: [],
    });

    const result = await client.callTool({
      name: 'message.post',
      arguments: {
        channel: 'general',
        text: 'hello beta fallback',
        workspace_id: 'ws_beta',
        as: 'BetaWriter',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({
      workspace_id: 'ws_beta',
      workspace_alias: undefined,
    }, 'BetaWriter');
    expect(betaWriterInbox).toHaveBeenCalledTimes(1);
    expect(betaInbox).not.toHaveBeenCalled();
    expect(activeInbox).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(2);
    expect(((result.content ?? []) as Array<{ text: string }>)[1]?.text).toContain('#beta-fallback: 4 unread');
  });
});
