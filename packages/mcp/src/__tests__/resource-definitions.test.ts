import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerResourceDefinitions } from '../resources/definitions.js';

describe('resource definitions with routing metadata', () => {
  let mcpServer: McpServer;
  let client: Client;

  const activeClient = {
    inbox: vi.fn(),
    channels: {
      list: vi.fn(),
    },
    messages: vi.fn(),
    thread: vi.fn(),
    dms: {
      messages: vi.fn(),
    },
  };
  const identityClient = {
    inbox: vi.fn(),
    channels: {
      list: vi.fn(),
    },
    messages: vi.fn(),
    thread: vi.fn(),
    dms: {
      messages: vi.fn(),
    },
  };
  const activeRelay = {
    agents: {
      list: vi.fn(),
    },
  };
  const identityRelay = {
    agents: {
      list: vi.fn(),
    },
  };

  const getAgentClient = vi.fn((_wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => {
    if (as === 'ReaderBot') {
      return identityClient as any;
    }
    return activeClient as any;
  });
  const getRelay = vi.fn((_wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => {
    if (as === 'ReaderBot') {
      return identityRelay as any;
    }
    return activeRelay as any;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerResourceDefinitions(mcpServer, getAgentClient, getRelay);

    client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);
  });

  it('resources/list keeps literal resource URIs stable', async () => {
    const result = await client.listResources();

    expect(result.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining([
      'relay://inbox',
      'relay://agents',
      'relay://channels',
    ]));
    expect(result.resources.some(resource => resource.uri.includes('/workspaces/'))).toBe(false);
  });

  it('resources/templates/list keeps literal template URIs stable', async () => {
    const result = await client.listResourceTemplates();

    expect(result.resourceTemplates.map(template => template.uriTemplate)).toEqual(expect.arrayContaining([
      'relay://channels/{name}/messages',
      'relay://messages/{id}/thread',
      'relay://dm/{conversation_id}',
    ]));
    expect(result.resourceTemplates.some(template => template.uriTemplate.includes('/workspaces/'))).toBe(false);
  });

  it('relay://agents reads use routed workspace and as metadata', async () => {
    identityRelay.agents.list.mockResolvedValue([{ name: 'ReaderBot' }]);

    const result = await client.readResource({
      uri: 'relay://agents',
      _meta: {
        workspace_id: 'ws_beta',
        as: 'ReaderBot',
      },
    });

    expect(getRelay).toHaveBeenCalledWith({ workspace_id: 'ws_beta', workspace_alias: undefined }, 'ReaderBot');
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual([{ name: 'ReaderBot' }]);
  });

  it('relay://channels falls back to the active identity when routing metadata is omitted', async () => {
    activeClient.channels.list.mockResolvedValue([{ name: 'general' }]);

    const result = await client.readResource({
      uri: 'relay://channels',
    });

    expect(getAgentClient).toHaveBeenCalledWith(undefined, undefined);
    expect((result.contents[0] as { uri: string }).uri).toBe('relay://channels');
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual([{ name: 'general' }]);
  });

  it('relay://channels/{name}/messages reads use routed workspace_alias and as metadata', async () => {
    identityClient.messages.mockResolvedValue([{ id: 'msg_beta' }]);

    const result = await client.readResource({
      uri: 'relay://channels/general/messages',
      _meta: {
        workspace_alias: 'beta',
        as: 'ReaderBot',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'ReaderBot');
    expect((result.contents[0] as { uri: string }).uri).toBe('relay://channels/general/messages');
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual([{ id: 'msg_beta' }]);
  });

  it('relay://inbox reads use routed workspace metadata and keep the literal URI', async () => {
    identityClient.inbox.mockResolvedValue({ unreadChannels: [{ channelName: 'ops', unreadCount: 2 }] });

    const result = await client.readResource({
      uri: 'relay://inbox',
      _meta: {
        workspace_alias: 'beta',
        as: 'ReaderBot',
      },
    });

    expect(getAgentClient).toHaveBeenCalledWith({ workspace_id: undefined, workspace_alias: 'beta' }, 'ReaderBot');
    expect((result.contents[0] as { uri: string }).uri).toBe('relay://inbox');
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual({
      unreadChannels: [{ channelName: 'ops', unreadCount: 2 }],
    });
  });
});
