import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const mocks = vi.hoisted(() => {
  const alphaAgentClient = {
    send: vi.fn().mockResolvedValue({ id: 'msg_alpha' }),
    messages: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue({ id: 'reply_alpha' }),
    thread: vi.fn().mockResolvedValue({ parent: {}, replies: [] }),
    dm: vi.fn().mockResolvedValue({}),
    inbox: vi.fn().mockResolvedValue({ unreadChannels: [], mentions: [], unreadDms: [], recentReactions: [] }),
    dms: {
      conversations: vi.fn().mockResolvedValue([]),
      createGroup: vi.fn().mockResolvedValue({ id: 'dm_alpha' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg_alpha_dm' }),
    },
  };
  const betaAgentClient = {
    send: vi.fn().mockResolvedValue({ id: 'msg_beta' }),
    messages: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue({ id: 'reply_beta' }),
    thread: vi.fn().mockResolvedValue({ parent: {}, replies: [] }),
    dm: vi.fn().mockResolvedValue({}),
    inbox: vi.fn().mockResolvedValue({ unreadChannels: [], mentions: [], unreadDms: [], recentReactions: [] }),
    dms: {
      conversations: vi.fn().mockResolvedValue([]),
      createGroup: vi.fn().mockResolvedValue({ id: 'dm_beta' }),
      sendMessage: vi.fn().mockResolvedValue({ id: 'msg_beta_dm' }),
    },
  };
  const managerAgentFor = vi.fn((workspace?: { workspaceId?: string; workspaceAlias?: string }) => {
    if (workspace?.workspaceId === 'ws_beta' || workspace?.workspaceAlias === 'beta') {
      return betaAgentClient;
    }
    return alphaAgentClient;
  });
  const createInternalWsClient = vi.fn(() => ({
    on: vi.fn().mockReturnValue(() => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  const createInternalRelayCast = vi.fn(() => ({
    as: vi.fn((token: string) => (token === 'at_live_beta' ? betaAgentClient : alphaAgentClient)),
    agents: {
      register: vi.fn().mockResolvedValue({ token: 'at_live_alpha' }),
      list: vi.fn().mockResolvedValue([]),
      registerOrRotate: vi.fn().mockResolvedValue({ token: 'at_live_alpha' }),
    },
    subscriptions: {
      create: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'sub_1' }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    webhooks: {
      create: vi.fn().mockResolvedValue({ id: 'wh_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      trigger: vi.fn().mockResolvedValue({ id: 'msg_1' }),
    },
    commands: {
      register: vi.fn().mockResolvedValue({ id: 'cmd_1' }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
  }));

  return {
    alphaAgentClient,
    betaAgentClient,
    managerAgentFor,
    createInternalWsClient,
    createInternalRelayCast,
  };
});

vi.mock('@relaycast/sdk', () => ({
  AgentClient: class {},
  MultiWorkspaceSessionManager: class {
    agentFor(workspace?: { workspaceId?: string; workspaceAlias?: string }) {
      return mocks.managerAgentFor(workspace);
    }
  },
}));

vi.mock('@relaycast/sdk/internal', () => ({
  createInternalRelayCast: mocks.createInternalRelayCast,
  createInternalWsClient: mocks.createInternalWsClient,
}));

import { createRelayMcpServer } from '../server.js';

describe('createRelayMcpServer multi-workspace routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes post_message to the explicit workspace alias', async () => {
    const server = createRelayMcpServer({
      workspaces: [
        {
          workspaceId: 'ws_alpha',
          workspaceAlias: 'alpha',
          workspaceKey: 'rk_live_alpha',
          agentToken: 'at_live_alpha',
          agentName: 'Alpha',
        },
        {
          workspaceId: 'ws_beta',
          workspaceAlias: 'beta',
          workspaceKey: 'rk_live_beta',
          agentToken: 'at_live_beta',
          agentName: 'Beta',
        },
      ],
      defaultWorkspace: 'alpha',
    });
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    const result = await client.callTool({
      name: 'post_message',
      arguments: { workspace_alias: 'beta', channel: 'ops', text: 'ship it' },
    });

    expect(result.isError).toBeFalsy();
    expect(mocks.managerAgentFor).toHaveBeenCalledWith({ workspaceId: 'ws_beta' });
    expect(mocks.betaAgentClient.send).toHaveBeenCalledWith('ops', 'ship it', undefined);
    expect(mocks.alphaAgentClient.send).not.toHaveBeenCalled();
  });

  it('fails loudly when multiple configured workspaces exist and no target is specified', async () => {
    const server = createRelayMcpServer({
      workspaces: [
        {
          workspaceId: 'ws_alpha',
          workspaceAlias: 'alpha',
          workspaceKey: 'rk_live_alpha',
          agentToken: 'at_live_alpha',
          agentName: 'Alpha',
        },
        {
          workspaceId: 'ws_beta',
          workspaceAlias: 'beta',
          workspaceKey: 'rk_live_beta',
          agentToken: 'at_live_beta',
          agentName: 'Beta',
        },
      ],
    });
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    const result = await client.callTool({
      name: 'post_message',
      arguments: { channel: 'general', text: 'hello' },
    });

    expect(result.isError).toBe(true);
    expect((result.content?.[0] as { text?: string } | undefined)?.text).toContain(
      'Ambiguous workspace selection. Provide workspace_id or workspace_alias.',
    );
  });
});
