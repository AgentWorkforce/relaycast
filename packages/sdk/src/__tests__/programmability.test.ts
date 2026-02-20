import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent.js';
import { HttpClient } from '../client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () =>
      Promise.resolve(
        apiOk ? { ok: true, data } : { ok: false, error: data },
      ),
  });
}

function mock204() {
  return Promise.resolve({
    ok: true,
    status: 204,
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
  });
}

describe('Programmability SDK', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // === Webhooks (workspace-level, on Relay class) ===

  describe('webhooks', () => {
    it('create() posts to /v1/webhooks', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ webhook_id: 'wh_1', name: 'GitHub', channel: 'dev', url: 'https://...', created_at: '2025-01-01' }),
      );
      await relay.webhooks.create({ name: 'GitHub', channel: 'dev' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/webhooks');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'GitHub', channel: 'dev' }));
    });

    it('list() gets /v1/webhooks', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.webhooks.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/webhooks');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/webhooks/:id (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.webhooks.delete('wh_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/webhooks/wh_1');
      expect(init.method).toBe('DELETE');
    });

    it('trigger() posts to /v1/hooks/:webhookId', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ message_id: 'm_1', channel: 'dev', text: 'alert', created_at: '2025-01-01' }),
      );
      await relay.webhooks.trigger('wh_1', { text: 'alert', source: 'github' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/hooks/wh_1');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ text: 'alert', source: 'github' }));
    });
  });

  // === Subscriptions (workspace-level, on Relay class) ===

  describe('subscriptions', () => {
    it('create() posts to /v1/subscriptions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ id: 'sub_1', events: ['message.created'], url: 'https://hook.example.com' }),
      );
      await relay.subscriptions.create({
        events: ['message.created'],
        url: 'https://hook.example.com',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/subscriptions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        events: ['message.created'],
        url: 'https://hook.example.com',
      });
    });

    it('list() gets /v1/subscriptions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.subscriptions.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/subscriptions');
      expect(init.method).toBe('GET');
    });

    it('get() gets /v1/subscriptions/:id', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ id: 'sub_1', events: ['message.created'], url: 'https://hook.example.com' }),
      );
      await relay.subscriptions.get('sub_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/subscriptions/sub_1');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/subscriptions/:id (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.subscriptions.delete('sub_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/subscriptions/sub_1');
      expect(init.method).toBe('DELETE');
    });
  });

  // === Commands (workspace-level on Relay, invoke on AgentClient) ===

  describe('commands', () => {
    it('register() posts to /v1/commands', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ id: 'cmd_1', command: 'deploy', description: 'Deploy app' }),
      );
      await relay.commands.register({
        command: 'deploy',
        description: 'Deploy the app',
        handlerAgent: 'DeployBot',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/commands');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        command: 'deploy',
        description: 'Deploy the app',
        handler_agent: 'DeployBot',
      });
    });

    it('list() gets /v1/commands', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.commands.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/commands');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/commands/:command (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.commands.delete('deploy');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/commands/deploy');
      expect(init.method).toBe('DELETE');
    });

    it('invoke() posts to /v1/commands/:command/invoke (agent-scoped)', async () => {
      const me = new AgentClient(new HttpClient({ apiKey: 'at_live_agent123' }));

      mockFetch.mockImplementation(() =>
        mockResponse({
          id: 'inv_1',
          command: 'deploy',
          channel: 'ops',
          invoked_by: 'agent_1',
          args: '--force',
          parameters: null,
          response_message_id: null,
          created_at: '2025-01-01',
        }),
      );
      await me.commands.invoke('deploy', { channel: 'ops', args: '--force' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/commands/deploy/invoke');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer at_live_agent123');
      expect(JSON.parse(init.body)).toEqual({ channel: 'ops', args: '--force' });
    });
  });

  // === Rich Message Blocks (on AgentClient.send / reply) ===

  describe('rich message blocks', () => {
    let me: AgentClient;

    beforeEach(() => {
      me = new AgentClient(new HttpClient({ apiKey: 'at_live_agent123' }));
    });

    it('send() passes blocks in the request body', async () => {
      const blocks = [
        { type: 'header' as const, text: 'Deploy Report' },
        { type: 'fields' as const, fields: [{ label: 'Status', value: 'Success' }] },
        { type: 'divider' as const },
      ];

      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));
      await me.send('#ops', 'Deploy complete', { blocks });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/ops/messages');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.text).toBe('Deploy complete');
      expect(body.blocks).toEqual(blocks);
    });

    it('send() works without blocks (backward-compatible)', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));
      await me.send('general', 'hello');

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.text).toBe('hello');
      expect(body.blocks).toBeUndefined();
    });

    it('send() passes both blocks and attachments', async () => {
      const blocks = [{ type: 'text' as const, text: 'See attached' }];

      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));
      await me.send('dev', 'File report', { blocks, attachments: ['f_1'] });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.blocks).toEqual(blocks);
      expect(body.attachments).toEqual(['f_1']);
    });

    it('reply() passes blocks in the request body', async () => {
      const blocks = [
        { type: 'actions' as const, elements: [{ type: 'button' as const, text: 'Approve', action_id: 'approve' }] },
      ];

      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));
      await me.reply('m_1', 'Please review', { blocks });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m_1/replies');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.text).toBe('Please review');
      expect(body.blocks).toEqual(blocks);
    });

    it('reply() works without blocks (backward-compatible)', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));
      await me.reply('m_1', 'Got it');

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.text).toBe('Got it');
      expect(body.blocks).toBeUndefined();
    });
  });
});
