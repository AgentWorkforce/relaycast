/**
 * Integration tests — verify complete MCP tool → SDK → HTTP chain.
 * Uses createRelayMcpServer (real wiring) with fetch intercepted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRelayMcpServer } from '../server.js';

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

describe('MCP → SDK → HTTP integration', () => {
  let client: Client;
  let captured: CapturedRequest[];
  let originalFetch: typeof global.fetch;

  function lastReq(): CapturedRequest {
    return captured[captured.length - 1];
  }

  function findReq(pred: (r: CapturedRequest) => boolean): CapturedRequest | undefined {
    return captured.find(pred);
  }

  beforeEach(async () => {
    captured = [];
    originalFetch = global.fetch;

    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const req: CapturedRequest = {
        url: url.toString(),
        method: (init?.method || 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        headers: Object.fromEntries(
          Object.entries(init?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      };
      captured.push(req);

      const path = new URL(url.toString()).pathname;
      let data: unknown = {};

      // Registration → return token so getAgentClient works
      if (path === '/v1/workspaces' && req.method === 'POST') {
        data = {
          workspace_id: 'ws_created',
          api_key: 'rk_live_created123',
          created_at: new Date().toISOString(),
        };
      } else if (path === '/v1/workspace' && req.method === 'GET') {
        const authHeader = req.headers.authorization;
        const name = authHeader === 'Bearer rk_live_ws2'
          ? 'Workspace Two'
          : authHeader === 'Bearer rk_live_ws3'
            ? 'Workspace Three'
            : 'Integration Workspace';
        data = {
          id: 'ws_info',
          name,
          system_prompt: null,
          plan: 'free',
          created_at: new Date().toISOString(),
          metadata: {},
        };
      } else if (path === '/v1/agents' && req.method === 'POST') {
        const authHeader = req.headers.authorization;
        const token = authHeader === 'Bearer rk_live_ws2'
          ? 'at_live_ws2'
          : authHeader === 'Bearer rk_live_ws3'
            ? 'at_live_ws3'
            : 'at_test_integration';
        data = {
          id: '1',
          name: req.body && (req.body as Record<string, unknown>).name,
          token,
          status: 'online',
        };
      } else if (path === '/v1/agents' && req.method === 'GET') {
        data = [{ id: '1', name: 'TestAgent', status: 'online' }];
      } else if (path.match(/\/v1\/channels\/[^/]+\/messages$/) && req.method === 'POST') {
        data = { id: 'msg1', body: (req.body as Record<string, unknown>)?.text, created_at: new Date().toISOString() };
      } else if (path.match(/\/v1\/channels\/[^/]+\/messages$/) && req.method === 'GET') {
        data = [{ id: 'msg1', body: 'Hello' }];
      } else if (path.match(/\/v1\/channels$/) && req.method === 'POST') {
        data = { id: '1', name: (req.body as Record<string, unknown>)?.name };
      } else if (path.match(/\/v1\/channels$/) && req.method === 'GET') {
        data = [{ id: '1', name: 'general' }];
      } else if (path.includes('/topic')) {
        data = { id: '1', name: 'general', topic: (req.body as Record<string, unknown>)?.topic };
      } else if (path.includes('/replies') && req.method === 'POST') {
        data = { id: 'r1', body: (req.body as Record<string, unknown>)?.text };
      } else if (path.includes('/replies')) {
        data = [{ id: 'r1', body: 'reply' }];
      } else if (path === '/v1/dm' && req.method === 'POST') {
        data = { id: 'dm1', text: (req.body as Record<string, unknown>)?.text };
      } else if (path.includes('/dm/conversations')) {
        data = [{ id: 'conv1' }];
      } else if (path.includes('/dm/group')) {
        data = {
          id: 'conv1',
          channel_id: 'ch1',
          dm_type: 'group',
          name: null,
          participants: [{ agent_id: 'a1' }, { agent_id: 'a2' }],
          created_at: new Date().toISOString(),
        };
      } else if (path.includes('/dm/conv1/messages')) {
        data = { id: 'dm_msg_1', conversation_id: 'conv1', text: (req.body as Record<string, unknown>)?.text };
      } else if (path.includes('/reactions') && req.method === 'POST') {
        data = {};
      } else if (path.includes('/search')) {
        data = [{ id: 'msg1', body: 'found' }];
      } else if (path.includes('/inbox')) {
        data = { unread: [], mentions: [] };
      } else if (path.includes('/read') && req.method === 'POST') {
        data = {};
      } else if (path.includes('/readers')) {
        data = [{ agent_name: 'Test' }];
      } else if (path.includes('/files/upload')) {
        data = { id: 'f1', upload_url: 'https://example.com/upload' };
      } else if (path.includes('/webhooks') && req.method === 'POST' && !path.includes('/hooks/')) {
        data = { webhook_id: 'wh_1', name: 'test', url: '/v1/hooks/wh_1' };
      } else if (path.includes('/webhooks') && req.method === 'GET') {
        data = [{ id: 'wh_1' }];
      } else if (path.includes('/hooks/') && req.method === 'POST') {
        data = { message_id: 'msg1' };
      } else if (path.includes('/subscriptions') && req.method === 'POST') {
        data = { id: 'sub_1' };
      } else if (path.includes('/subscriptions') && req.method === 'GET') {
        data = [{ id: 'sub_1' }];
      } else if (path.includes('/commands') && req.method === 'POST' && path.includes('/invoke')) {
        data = { result: 'ok' };
      } else if (path.includes('/commands') && req.method === 'POST') {
        data = { command: 'test' };
      } else if (path.includes('/commands') && req.method === 'GET') {
        data = [{ command: 'test' }];
      }

      // DELETE endpoints return 204 No Content (matches real server)
      if (req.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({ ok: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof global.fetch;

    const mcpServer = createRelayMcpServer({
      apiKey: 'rk_live_int1',
      baseUrl: 'https://api.test.dev',
    });

    client = new Client({ name: 'integration-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);

    // Register first to enable agent-token-dependent tools
    await client.callTool({
      name: 'agent.register',
      arguments: { name: 'IntegrationBot', persona: 'test bot' },
    });
    captured = []; // Reset captures after registration
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── Auth ──────────────────────────────────────────────

  it('uses agent token for authenticated requests after register', async () => {
    await client.callTool({ name: 'channel.list', arguments: {} });
    expect(captured[0].headers['authorization']).toBe('Bearer at_test_integration');
  });

  it('sends mcp origin headers on relay API requests', async () => {
    await client.callTool({ name: 'channel.list', arguments: {} });
    const req = lastReq();
    expect(req.headers['x-relaycast-origin-surface']).toBe('mcp');
    expect(req.headers['x-relaycast-origin-client']).toBe('@relaycast/mcp');
    expect(req.headers['x-relaycast-origin-version']).toBeDefined();
  });

  // ─── Workspaces ────────────────────────────────────────

  it('workspace.create → POST /v1/workspaces', async () => {
    captured = [];
    await client.callTool({ name: 'workspace.create', arguments: { name: 'project-alpha' } });
    const req = findReq((r) => r.url.endsWith('/v1/workspaces') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ name: 'project-alpha' });
  });

  it('workspace.set_key switches workspace-level auth for agent.list', async () => {
    captured = [];
    await client.callTool({ name: 'workspace.set_key', arguments: { api_key: 'rk_live_ws2' } });
    await client.callTool({ name: 'agent.list', arguments: {} });
    const req = findReq((r) => r.url.endsWith('/v1/agents') && r.method === 'GET');
    expect(req).toBeDefined();
    expect(req!.headers.authorization).toBe('Bearer rk_live_ws2');
  });

  it('workspace.join registers in the new workspace and uses the restored agent token', async () => {
    captured = [];
    await client.callTool({ name: 'workspace.join', arguments: { api_key: 'rk_live_ws2', name: 'Ws2Bot' } });
    await client.callTool({ name: 'channel.list', arguments: {} });

    const registerReq = findReq((r) => r.url.endsWith('/v1/agents') && r.method === 'POST');
    const listReq = findReq((r) => r.url.endsWith('/v1/channels') && r.method === 'GET');

    expect(registerReq).toBeDefined();
    expect(registerReq!.headers.authorization).toBe('Bearer rk_live_ws2');
    expect(registerReq!.body).toMatchObject({ name: 'Ws2Bot' });
    expect(listReq).toBeDefined();
    expect(listReq!.headers.authorization).toBe('Bearer at_live_ws2');
  });

  it('workspace.list returns joined workspaces after joining another workspace', async () => {
    await client.callTool({ name: 'workspace.join', arguments: { api_key: 'rk_live_ws2', name: 'Ws2Bot' } });
    const result = await client.callTool({ name: 'workspace.list', arguments: {} });
    const payload = JSON.parse(((result.content ?? []) as Array<{ text: string }>)[0]!.text) as {
      workspaces: Array<{ agent_name: string; is_active: boolean; workspace_ref: string }>;
      active_workspace_ref: string | null;
    };

    expect(payload.workspaces).toHaveLength(2);
    expect(payload.workspaces.some((workspace) => workspace.agent_name === 'IntegrationBot')).toBe(true);
    expect(payload.workspaces.some((workspace) => workspace.agent_name === 'Ws2Bot' && workspace.is_active)).toBe(true);
    expect(payload.active_workspace_ref).toMatch(/^ws_[a-f0-9]{12}$/);
  });

  it('workspace.switch restores the previous workspace agent token from workspace_ref', async () => {
    await client.callTool({ name: 'workspace.join', arguments: { api_key: 'rk_live_ws2', name: 'Ws2Bot' } });
    const listResult = await client.callTool({ name: 'workspace.list', arguments: {} });
    const payload = JSON.parse(((listResult.content ?? []) as Array<{ text: string }>)[0]!.text) as {
      workspaces: Array<{ workspace_ref: string; agent_name: string }>;
    };
    const target = payload.workspaces.find((workspace) => workspace.agent_name === 'IntegrationBot');

    captured = [];
    await client.callTool({
      name: 'workspace.switch',
      arguments: { workspace_ref: target!.workspace_ref },
    });
    await client.callTool({ name: 'channel.list', arguments: {} });
    const req = findReq((r) => r.url.endsWith('/v1/channels') && r.method === 'GET');
    expect(req).toBeDefined();
    expect(req!.headers.authorization).toBe('Bearer at_test_integration');
  });

  it('workspace.switch accepts the canonical workspace_name from the API', async () => {
    await client.callTool({ name: 'workspace.join', arguments: { api_key: 'rk_live_ws2', name: 'Ws2Bot' } });

    captured = [];
    await client.callTool({
      name: 'workspace.switch',
      arguments: { workspace_name: 'Integration Workspace' },
    });
    await client.callTool({ name: 'channel.list', arguments: {} });

    const req = findReq((r) => r.url.endsWith('/v1/channels') && r.method === 'GET');
    expect(req).toBeDefined();
    expect(req!.headers.authorization).toBe('Bearer at_test_integration');
  });

  // ─── Channels ──────────────────────────────────────────

  it('channel.create → POST /v1/channels', async () => {
    await client.callTool({ name: 'channel.create', arguments: { name: 'eng', topic: 'Engineering' } });
    const req = findReq((r) => r.url.includes('/v1/channels') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ name: 'eng', topic: 'Engineering' });
  });

  it('channel.list → GET /v1/channels', async () => {
    await client.callTool({ name: 'channel.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/v1/channels') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('channel.join → POST /v1/channels/:name/join', async () => {
    await client.callTool({ name: 'channel.join', arguments: { channel: 'general' } });
    const req = findReq((r) => r.url.includes('/channels/general/join'));
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
  });

  it('channel.leave → POST /v1/channels/:name/leave', async () => {
    await client.callTool({ name: 'channel.leave', arguments: { channel: 'dev' } });
    const req = findReq((r) => r.url.includes('/channels/dev/leave'));
    expect(req).toBeDefined();
  });

  it('channel.invite → POST /channels/:name/invite {agent_name}', async () => {
    await client.callTool({ name: 'channel.invite', arguments: { channel: 'general', agent: 'bot1' } });
    const req = findReq((r) => r.url.includes('/channels/general/invite'));
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ agent_name: 'bot1' });
  });

  it('channel.set_topic → PATCH /v1/channels/:name/topic', async () => {
    await client.callTool({ name: 'channel.set_topic', arguments: { channel: 'general', topic: 'New' } });
    const req = findReq((r) => r.url.includes('/channels/general/topic') && r.method === 'PATCH');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ topic: 'New' });
  });

  it('channel.archive → DELETE /v1/channels/:name', async () => {
    await client.callTool({ name: 'channel.archive', arguments: { channel: 'old' } });
    const req = findReq((r) => r.url.includes('/channels/old') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  // ─── Messaging ─────────────────────────────────────────

  it('message.post → POST /v1/channels/:name/messages', async () => {
    await client.callTool({ name: 'message.post', arguments: { channel: 'general', text: 'Hello' } });
    const req = findReq((r) => r.url.includes('/channels/general/messages') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ text: 'Hello' });
  });

  it('message.list → GET /v1/channels/:name/messages', async () => {
    await client.callTool({ name: 'message.list', arguments: { channel: 'general' } });
    const req = findReq((r) => r.url.includes('/channels/general/messages') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('message.reply → POST /v1/messages/:id/replies', async () => {
    await client.callTool({ name: 'message.reply', arguments: { message_id: 'msg1', text: 'Reply' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/replies') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ text: 'Reply' });
  });

  it('message.get_thread → GET /v1/messages/:id/replies', async () => {
    await client.callTool({ name: 'message.get_thread', arguments: { message_id: 'msg1' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/replies') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('message.dm.send → POST /v1/dm', async () => {
    await client.callTool({ name: 'message.dm.send', arguments: { to: 'Alice', text: 'Hi' } });
    const req = findReq((r) => r.url.endsWith('/v1/dm') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ to: 'Alice', text: 'Hi' });
  });

  it('message.dm.list → GET /v1/dm/conversations', async () => {
    await client.callTool({ name: 'message.dm.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/dm/conversations'));
    expect(req).toBeDefined();
  });

  it('message.dm.send_group → POST /v1/dm/group then POST /v1/dm/:id/messages', async () => {
    await client.callTool({ name: 'message.dm.send_group', arguments: { participants: ['A', 'B'], text: 'Hello' } });
    const createReq = findReq((r) => r.url.includes('/dm/group'));
    const sendReq = findReq((r) => r.url.includes('/dm/conv1/messages'));
    expect(createReq).toBeDefined();
    expect(createReq!.body).toMatchObject({ participants: ['A', 'B'] });
    expect(sendReq).toBeDefined();
    expect(sendReq!.body).toMatchObject({ text: 'Hello' });
  });

  // ─── Features ──────────────────────────────────────────

  it('message.reaction.add → POST /v1/messages/:id/reactions', async () => {
    await client.callTool({ name: 'message.reaction.add', arguments: { message_id: 'msg1', emoji: 'rocket' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/reactions') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ emoji: '🚀' });
  });

  it('message.reaction.remove → DELETE /v1/messages/:id/reactions/:emoji', async () => {
    await client.callTool({ name: 'message.reaction.remove', arguments: { message_id: 'msg1', emoji: 'rocket' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/reactions/') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('message.search → GET /v1/search?q=...', async () => {
    await client.callTool({ name: 'message.search', arguments: { query: 'hello' } });
    const req = findReq((r) => r.url.includes('/search'));
    expect(req).toBeDefined();
    expect(req!.url).toContain('q=hello');
  });

  it('message.inbox.check → GET /v1/inbox', async () => {
    await client.callTool({ name: 'message.inbox.check', arguments: {} });
    const req = findReq((r) => r.url.includes('/inbox'));
    expect(req).toBeDefined();
  });

  it('message.inbox.mark_read → POST /v1/messages/:id/read', async () => {
    await client.callTool({ name: 'message.inbox.mark_read', arguments: { message_id: 'msg1' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/read'));
    expect(req).toBeDefined();
  });

  it('message.file.upload → POST /v1/files/upload', async () => {
    await client.callTool({
      name: 'message.file.upload',
      arguments: { filename: 'test.txt', content_type: 'text/plain', size_bytes: 100 },
    });
    const req = findReq((r) => r.url.includes('/files/upload'));
    expect(req).toBeDefined();
  });

  // ─── Registration ──────────────────────────────────────

  it('agent.register → POST /v1/agents', async () => {
    // We already registered in beforeEach, test with a new registration
    captured = [];
    await client.callTool({ name: 'agent.register', arguments: { name: 'NewBot', persona: 'new' } });
    const req = findReq((r) => r.url.includes('/agents') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ name: 'NewBot', persona: 'new' });
  });

  it('agent.list → GET /v1/agents', async () => {
    await client.callTool({ name: 'agent.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/agents') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  // ─── Programmability ───────────────────────────────────

  it('webhook.create → POST /v1/webhooks', async () => {
    await client.callTool({ name: 'webhook.create', arguments: { name: 'gh', channel: 'eng' } });
    const req = findReq((r) => r.url.includes('/webhooks') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ name: 'gh', channel: 'eng' });
  });

  it('webhook.list → GET /v1/webhooks', async () => {
    await client.callTool({ name: 'webhook.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/webhooks') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('webhook.delete → DELETE /v1/webhooks/:id', async () => {
    await client.callTool({ name: 'webhook.delete', arguments: { webhook_id: 'wh_1' } });
    const req = findReq((r) => r.url.includes('/webhooks/wh_1') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('webhook.trigger → POST /v1/hooks/:id', async () => {
    await client.callTool({ name: 'webhook.trigger', arguments: { webhook_id: 'wh_1', text: 'test' } });
    const req = findReq((r) => r.url.includes('/hooks/wh_1') && r.method === 'POST');
    expect(req).toBeDefined();
  });

  it('subscription.create → POST /v1/subscriptions', async () => {
    await client.callTool({ name: 'subscription.create', arguments: { events: ['message.created'], url: 'https://example.com/hook' } });
    const req = findReq((r) => r.url.includes('/subscriptions') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ events: ['message.created'], url: 'https://example.com/hook' });
  });

  it('subscription.list → GET /v1/subscriptions', async () => {
    await client.callTool({ name: 'subscription.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/subscriptions') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('subscription.delete → DELETE /v1/subscriptions/:id', async () => {
    await client.callTool({ name: 'subscription.delete', arguments: { subscription_id: 'sub_1' } });
    const req = findReq((r) => r.url.includes('/subscriptions/sub_1') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('command.register → POST /v1/commands', async () => {
    await client.callTool({ name: 'command.register', arguments: { command: 'deploy', description: 'Deploy', handler_agent: 'IntegrationBot' } });
    const req = findReq((r) => r.url.includes('/commands') && r.method === 'POST' && !r.url.includes('/invoke'));
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ command: 'deploy', description: 'Deploy', handler_agent: 'IntegrationBot' });
  });

  it('command.list → GET /v1/commands', async () => {
    await client.callTool({ name: 'command.list', arguments: {} });
    const req = findReq((r) => r.url.includes('/commands') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('command.delete → DELETE /v1/commands/:command', async () => {
    await client.callTool({ name: 'command.delete', arguments: { command: 'deploy' } });
    const req = findReq((r) => r.url.includes('/commands/deploy') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('command.invoke → POST /v1/commands/:command/invoke', async () => {
    await client.callTool({ name: 'command.invoke', arguments: { command: 'deploy', channel: 'general' } });
    const req = findReq((r) => r.url.includes('/commands/deploy/invoke'));
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ channel: 'general' });
  });
});
