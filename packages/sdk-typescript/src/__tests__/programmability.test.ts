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
        mockResponse({
          webhook_id: 'wh_1',
          name: 'GitHub',
          channel: 'dev',
          url: 'https://...',
          token: 'wh_live_1',
          is_active: true,
          created_at: '2025-01-01',
        }),
      );
      const created = await relay.webhooks.create({ name: 'GitHub', channel: 'dev' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/webhooks');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'GitHub', channel: 'dev' }));
      expect(created.token).toBe('wh_live_1');
    });

    it('createInbound() aliases webhook creation for inbound SDK contract', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({
          webhook_id: 'wh_1',
          name: 'dev',
          channel: 'dev',
          url: 'https://gateway.relaycast.dev/v1/hooks/wh_1',
          token: 'wh_live_1',
          is_active: true,
          created_at: '2025-01-01',
        }),
      );
      await relay.webhooks.createInbound({ channel: 'dev' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/webhooks');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ channel: 'dev' }));
    });

    it('list() gets /v1/webhooks', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.webhooks.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/webhooks');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/webhooks/:id (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.webhooks.delete('wh_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/webhooks/wh_1');
      expect(init.method).toBe('DELETE');
    });

    it('trigger() posts to /v1/hooks/:webhookId', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({
          message_id: 'm_1',
          channel: 'dev',
          text: 'alert',
          source: null,
          author: 'GitHub',
          created_at: '2025-01-01',
        }),
      );
      await relay.webhooks.trigger('wh_1', { message: 'alert', author: 'GitHub' }, 'wh_live_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/hooks/wh_1');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer wh_live_1');
      expect(init.body).toBe(JSON.stringify({ message: 'alert', author: 'GitHub' }));
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
        headers: { Authorization: 'Bearer downstream' },
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/subscriptions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        events: ['message.created'],
        url: 'https://hook.example.com',
        headers: { Authorization: 'Bearer downstream' },
      });
    });

    it('list() gets /v1/subscriptions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.subscriptions.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/subscriptions');
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
      expect(url).toBe('https://gateway.relaycast.dev/v1/subscriptions/sub_1');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/subscriptions/:id (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.subscriptions.delete('sub_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/subscriptions/sub_1');
      expect(init.method).toBe('DELETE');
    });
  });

  // === Actions (workspace-level on Relay, invoke on AgentClient) ===

  describe('actions', () => {
    it('register() posts to /v1/actions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ id: 'act_1', name: 'deploy', description: 'Deploy app', handler_agent: 'DeployBot' }),
      );
      await relay.actions.register({
        name: 'deploy',
        description: 'Deploy the app',
        handlerAgent: 'DeployBot',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/actions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        name: 'deploy',
        description: 'Deploy the app',
        handler_agent: 'DeployBot',
      });
    });

    it('list() gets /v1/actions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.actions.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/actions');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/actions/:name (handles 204)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mock204());
      await relay.actions.delete('deploy');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/actions/deploy');
      expect(init.method).toBe('DELETE');
    });

    it('invoke() posts to /v1/actions/:name/invoke (agent-scoped)', async () => {
      const me = new AgentClient(new HttpClient({ apiKey: 'at_live_agent123' }));

      mockFetch.mockImplementation(() =>
        mockResponse({
          invocation_id: 'inv_1',
          action_name: 'deploy',
          handler_agent_id: 'agent_handler_1',
          input: { force: true },
          status: 'invoked',
          created_at: '2025-01-01',
        }),
      );
      await me.actions.invoke('deploy', { force: true });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/actions/deploy/invoke');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer at_live_agent123');
      expect(JSON.parse(init.body)).toEqual({ input: { force: true } });
    });
  });

  // === New engine bindings (actions invocations, agent events, certify, directory, console) ===

  describe('engine bindings', () => {
    it('actions.completeInvocation() posts to the invocation complete route', async () => {
      const me = new AgentClient(new HttpClient({ apiKey: 'at_live_agent123' }));
      mockFetch.mockImplementation(() => mockResponse({ invocation_id: 'inv_1', action_name: 'deploy', status: 'completed' }));
      await me.actions.completeInvocation('deploy', 'inv_1', { output: { ok: true }, durationMs: 12 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/actions/deploy/invocations/inv_1/complete');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ output: { ok: true }, duration_ms: 12 });
    });

    it('agents.events.emit() posts a session event', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ id: 'evt_1', agent_id: 'agent_1', type: 'status.active', payload: {}, created_at: '2025-01-01' }, true, 201));
      await relay.agents.events.emit('Worker', { type: 'status.active' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/agents/Worker/events');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ type: 'status.active' });
    });

    it('agents.events.list() gets session events with filters', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.events.list('Worker', { type: 'status.active', limit: 50 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/agents/Worker/events?type=status.active&limit=50');
      expect(init.method).toBe('GET');
    });

    it('certify.submit() posts to /v1/certify', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ id: 'cert_1', agent_url: 'https://a.dev', level: 1, passed: true, passed_tests: 3, total_tests: 3, tests: [] }, true, 201));
      await relay.certify.submit({ agentUrl: 'https://a.dev', level: 1 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/certify');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ agent_url: 'https://a.dev', level: 1 });
    });

    it('certify.badgeUrl() builds the public badge URL', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      expect(relay.certify.badgeUrl('cert_1')).toBe('https://gateway.relaycast.dev/v1/certify/cert_1/badge.svg');
    });

    it('listDirectory() gets /v1/directory/agents with status filter', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.listDirectory({ status: 'active', limit: 10 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/directory/agents?status=active&limit=10');
      expect(init.method).toBe('GET');
    });

    it('rateDirectoryAgent() posts a rating', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ id: 'drate_1', score: 5, review: 'great', rater_agent_id: 'a1', rater_agent_name: 'A', created_at: '2025-01-01', updated_at: '2025-01-01' }, true, 201));
      await relay.rateDirectoryAgent('my-agent', { score: 5, review: 'great' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/directory/agents/my-agent/ratings');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ score: 5, review: 'great' });
    });

    it('searchSkills() gets /v1/skills/search', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.searchSkills({ q: 'deploy', limit: 5 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/skills/search?q=deploy&limit=5');
      expect(init.method).toBe('GET');
    });

    it('routeFeedback() posts to /v1/route/feedback', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      await relay.routeFeedback({ agentName: 'Worker', success: true });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/route/feedback');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ agent_name: 'Worker', success: true });
    });

    it('console.stats() gets /v1/console/stats with window', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ window_days: 7 }));
      await relay.console.stats({ days: 7 });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/console/stats?days=7');
      expect(init.method).toBe('GET');
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
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/ops/messages');
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
      expect(url).toBe('https://gateway.relaycast.dev/v1/messages/m_1/replies');
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
