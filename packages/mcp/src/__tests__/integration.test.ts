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
      if (path === '/v1/agents' && req.method === 'POST') {
        data = { id: '1', name: req.body && (req.body as Record<string, unknown>).name, token: 'at_test_integration', status: 'online' };
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
        data = { conversation_id: 'conv1' };
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
      apiKey: 'rk_test_integration123456789abcdef',
      baseUrl: 'https://api.test.dev',
    });

    client = new Client({ name: 'integration-client', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), mcpServer.connect(st)]);

    // Register first to enable agent-token-dependent tools
    await client.callTool({
      name: 'register',
      arguments: { name: 'IntegrationBot', persona: 'test bot' },
    });
    captured = []; // Reset captures after registration
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── Auth ──────────────────────────────────────────────

  it('uses agent token for authenticated requests after register', async () => {
    await client.callTool({ name: 'list_channels', arguments: {} });
    expect(captured[0].headers['authorization']).toBe('Bearer at_test_integration');
  });

  it('sends mcp origin headers on relay API requests', async () => {
    await client.callTool({ name: 'list_channels', arguments: {} });
    const req = lastReq();
    expect(req.headers['x-relaycast-origin-surface']).toBe('mcp');
    expect(req.headers['x-relaycast-origin-client']).toBe('@relaycast/mcp');
    expect(req.headers['x-relaycast-origin-version']).toBeDefined();
  });

  // ─── Channels ──────────────────────────────────────────

  it('create_channel → POST /v1/channels', async () => {
    await client.callTool({ name: 'create_channel', arguments: { name: 'eng', topic: 'Engineering' } });
    const req = findReq((r) => r.url.includes('/v1/channels') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ name: 'eng', topic: 'Engineering' });
  });

  it('list_channels → GET /v1/channels', async () => {
    await client.callTool({ name: 'list_channels', arguments: {} });
    const req = findReq((r) => r.url.includes('/v1/channels') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('join_channel → POST /v1/channels/:name/join', async () => {
    await client.callTool({ name: 'join_channel', arguments: { channel: 'general' } });
    const req = findReq((r) => r.url.includes('/channels/general/join'));
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');
  });

  it('leave_channel → POST /v1/channels/:name/leave', async () => {
    await client.callTool({ name: 'leave_channel', arguments: { channel: 'dev' } });
    const req = findReq((r) => r.url.includes('/channels/dev/leave'));
    expect(req).toBeDefined();
  });

  it('invite_to_channel → POST /channels/:name/invite {agent}', async () => {
    await client.callTool({ name: 'invite_to_channel', arguments: { channel: 'general', agent: 'bot1' } });
    const req = findReq((r) => r.url.includes('/channels/general/invite'));
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ agent: 'bot1' });
  });

  it('set_channel_topic → PATCH /v1/channels/:name/topic', async () => {
    await client.callTool({ name: 'set_channel_topic', arguments: { channel: 'general', topic: 'New' } });
    const req = findReq((r) => r.url.includes('/channels/general/topic') && r.method === 'PATCH');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ topic: 'New' });
  });

  it('archive_channel → DELETE /v1/channels/:name', async () => {
    await client.callTool({ name: 'archive_channel', arguments: { channel: 'old' } });
    const req = findReq((r) => r.url.includes('/channels/old') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  // ─── Messaging ─────────────────────────────────────────

  it('post_message → POST /v1/channels/:name/messages', async () => {
    await client.callTool({ name: 'post_message', arguments: { channel: 'general', text: 'Hello' } });
    const req = findReq((r) => r.url.includes('/channels/general/messages') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ text: 'Hello' });
  });

  it('get_messages → GET /v1/channels/:name/messages', async () => {
    await client.callTool({ name: 'get_messages', arguments: { channel: 'general' } });
    const req = findReq((r) => r.url.includes('/channels/general/messages') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('reply_to_thread → POST /v1/messages/:id/replies', async () => {
    await client.callTool({ name: 'reply_to_thread', arguments: { message_id: 'msg1', text: 'Reply' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/replies') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ text: 'Reply' });
  });

  it('get_thread → GET /v1/messages/:id/replies', async () => {
    await client.callTool({ name: 'get_thread', arguments: { message_id: 'msg1' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/replies') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('send_dm → POST /v1/dm', async () => {
    await client.callTool({ name: 'send_dm', arguments: { to: 'Alice', text: 'Hi' } });
    const req = findReq((r) => r.url.endsWith('/v1/dm') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ to: 'Alice', text: 'Hi' });
  });

  it('get_dms → GET /v1/dm/conversations', async () => {
    await client.callTool({ name: 'get_dms', arguments: {} });
    const req = findReq((r) => r.url.includes('/dm/conversations'));
    expect(req).toBeDefined();
  });

  it('send_group_dm → POST /v1/dm/group', async () => {
    await client.callTool({ name: 'send_group_dm', arguments: { participants: ['A', 'B'], text: 'Hello' } });
    const req = findReq((r) => r.url.includes('/dm/group'));
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ participants: ['A', 'B'], text: 'Hello' });
  });

  // ─── Features ──────────────────────────────────────────

  it('add_reaction → POST /v1/messages/:id/reactions', async () => {
    await client.callTool({ name: 'add_reaction', arguments: { message_id: 'msg1', emoji: 'rocket' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/reactions') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toEqual({ emoji: 'rocket' });
  });

  it('remove_reaction → DELETE /v1/messages/:id/reactions/:emoji', async () => {
    await client.callTool({ name: 'remove_reaction', arguments: { message_id: 'msg1', emoji: 'rocket' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/reactions/rocket') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('search_messages → GET /v1/search?q=...', async () => {
    await client.callTool({ name: 'search_messages', arguments: { query: 'hello' } });
    const req = findReq((r) => r.url.includes('/search'));
    expect(req).toBeDefined();
    expect(req!.url).toContain('q=hello');
  });

  it('check_inbox → GET /v1/inbox', async () => {
    await client.callTool({ name: 'check_inbox', arguments: {} });
    const req = findReq((r) => r.url.includes('/inbox'));
    expect(req).toBeDefined();
  });

  it('mark_read → POST /v1/messages/:id/read', async () => {
    await client.callTool({ name: 'mark_read', arguments: { message_id: 'msg1' } });
    const req = findReq((r) => r.url.includes('/messages/msg1/read'));
    expect(req).toBeDefined();
  });

  it('upload_file → POST /v1/files/upload', async () => {
    await client.callTool({
      name: 'upload_file',
      arguments: { filename: 'test.txt', content_type: 'text/plain', size_bytes: 100 },
    });
    const req = findReq((r) => r.url.includes('/files/upload'));
    expect(req).toBeDefined();
  });

  // ─── Registration ──────────────────────────────────────

  it('register → POST /v1/agents', async () => {
    // We already registered in beforeEach, test with a new registration
    captured = [];
    await client.callTool({ name: 'register', arguments: { name: 'NewBot', persona: 'new' } });
    const req = findReq((r) => r.url.includes('/agents') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ name: 'NewBot', persona: 'new' });
  });

  it('list_agents → GET /v1/agents', async () => {
    await client.callTool({ name: 'list_agents', arguments: {} });
    const req = findReq((r) => r.url.includes('/agents') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  // ─── Programmability ───────────────────────────────────

  it('create_webhook → POST /v1/webhooks', async () => {
    await client.callTool({ name: 'create_webhook', arguments: { name: 'gh', channel: 'eng' } });
    const req = findReq((r) => r.url.includes('/webhooks') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ name: 'gh', channel: 'eng' });
  });

  it('list_webhooks → GET /v1/webhooks', async () => {
    await client.callTool({ name: 'list_webhooks', arguments: {} });
    const req = findReq((r) => r.url.includes('/webhooks') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('delete_webhook → DELETE /v1/webhooks/:id', async () => {
    await client.callTool({ name: 'delete_webhook', arguments: { webhook_id: 'wh_1' } });
    const req = findReq((r) => r.url.includes('/webhooks/wh_1') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('trigger_webhook → POST /v1/hooks/:id', async () => {
    await client.callTool({ name: 'trigger_webhook', arguments: { webhook_id: 'wh_1', text: 'test' } });
    const req = findReq((r) => r.url.includes('/hooks/wh_1') && r.method === 'POST');
    expect(req).toBeDefined();
  });

  it('create_subscription → POST /v1/subscriptions', async () => {
    await client.callTool({ name: 'create_subscription', arguments: { events: ['message.created'], url: 'https://example.com/hook' } });
    const req = findReq((r) => r.url.includes('/subscriptions') && r.method === 'POST');
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ events: ['message.created'], url: 'https://example.com/hook' });
  });

  it('list_subscriptions → GET /v1/subscriptions', async () => {
    await client.callTool({ name: 'list_subscriptions', arguments: {} });
    const req = findReq((r) => r.url.includes('/subscriptions') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('delete_subscription → DELETE /v1/subscriptions/:id', async () => {
    await client.callTool({ name: 'delete_subscription', arguments: { subscription_id: 'sub_1' } });
    const req = findReq((r) => r.url.includes('/subscriptions/sub_1') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('register_command → POST /v1/commands', async () => {
    await client.callTool({ name: 'register_command', arguments: { command: 'deploy', description: 'Deploy', handler_agent: 'IntegrationBot' } });
    const req = findReq((r) => r.url.includes('/commands') && r.method === 'POST' && !r.url.includes('/invoke'));
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ command: 'deploy', description: 'Deploy', handler_agent: 'IntegrationBot' });
  });

  it('list_commands → GET /v1/commands', async () => {
    await client.callTool({ name: 'list_commands', arguments: {} });
    const req = findReq((r) => r.url.includes('/commands') && r.method === 'GET');
    expect(req).toBeDefined();
  });

  it('delete_command → DELETE /v1/commands/:command', async () => {
    await client.callTool({ name: 'delete_command', arguments: { command: 'deploy' } });
    const req = findReq((r) => r.url.includes('/commands/deploy') && r.method === 'DELETE');
    expect(req).toBeDefined();
  });

  it('invoke_command → POST /v1/commands/:command/invoke', async () => {
    await client.callTool({ name: 'invoke_command', arguments: { command: 'deploy', channel: 'general' } });
    const req = findReq((r) => r.url.includes('/commands/deploy/invoke'));
    expect(req).toBeDefined();
    expect(req!.body).toMatchObject({ channel: 'general' });
  });
});
