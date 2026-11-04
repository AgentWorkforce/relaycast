import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent.js';
import { HttpClient } from '../client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(apiOk ? { ok: true, data } : { ok: false, error: data }),
  });
}

describe('AgentClient durable delivery', () => {
  let me: AgentClient;

  beforeEach(() => {
    mockFetch.mockReset();
    me = new AgentClient(new HttpClient({ apiKey: 'at_live_test123' }));
  });

  describe('messageDeliveries()', () => {
    it('GETs /v1/messages/:id/deliveries and camelizes the receipts', async () => {
      mockFetch.mockImplementation(() => mockResponse({
        message_id: 'm 1',
        deliveries: [{ id: 'del_1', agent_id: 'a_bob', agent_name: 'bob', status: 'acked', read_at: null, acked_at: '2026-06-01T00:00:02.000Z' }],
      }));

      const result = await me.messageDeliveries('m 1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/messages/m%201/deliveries');
      expect(init.method).toBe('GET');
      expect(result.messageId).toBe('m 1');
      expect(result.deliveries[0]).toMatchObject({ agentName: 'bob', status: 'acked', readAt: null, ackedAt: '2026-06-01T00:00:02.000Z' });
    });
  });

  describe('deliveries()', () => {
    it('GETs /v1/deliveries with no query by default', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));

      await me.deliveries();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/deliveries');
      expect(init.method).toBe('GET');
    });

    it('passes status and limit as query params', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));

      await me.deliveries({ status: 'queued', limit: 25 });

      const [url] = mockFetch.mock.calls[0]!;
      const parsed = new URL(url as string);
      expect(parsed.pathname).toBe('/v1/deliveries');
      expect(parsed.searchParams.get('status')).toBe('queued');
      expect(parsed.searchParams.get('limit')).toBe('25');
    });

    it('passes waitMs as the wait long-poll query param', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));

      await me.deliveries({ limit: 50, waitMs: 25_000 });

      const parsed = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(parsed.searchParams.get('wait')).toBe('25000');
      expect(parsed.searchParams.get('limit')).toBe('50');
    });

    it('camelizes the delivery items in the response', async () => {
      mockFetch.mockImplementation(() => mockResponse([
        { id: 'del_1', message_id: 'm_1', channel_id: 'c_1', available_at: null, message: { agent_name: 'bob' } },
      ]));

      const items = await me.deliveries();

      expect(items[0]).toMatchObject({ id: 'del_1', messageId: 'm_1', channelId: 'c_1', availableAt: null });
      expect(items[0]!.message).toMatchObject({ agentName: 'bob' });
    });
  });

  describe('ackDelivery()', () => {
    it('POSTs to /v1/deliveries/:id/ack', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'del_1', status: 'acked' }));

      await me.ackDelivery('del_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/deliveries/del_1/ack');
      expect(init.method).toBe('POST');
    });

    it('URL-encodes the delivery id', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'del/1' }));

      await me.ackDelivery('del/1');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/deliveries/del%2F1/ack');
    });
  });

  describe('failDelivery()', () => {
    it('POSTs error and retryable to /v1/deliveries/:id/fail', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'del_1', status: 'failed' }));

      await me.failDelivery('del_1', { error: 'boom', retryable: true });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/deliveries/del_1/fail');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ error: 'boom', retryable: true });
    });

    it('sends an empty body when no options are given', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'del_1', status: 'failed' }));

      await me.failDelivery('del_1');

      const [, init] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(init.body)).toEqual({});
    });
  });

  describe('deferDelivery()', () => {
    it('decamelizes availableAt -> available_at in the body', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'del_1', status: 'queued' }));
      const availableAt = '2026-06-01T00:01:00.000Z';

      await me.deferDelivery('del_1', { availableAt, reason: 'busy' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/deliveries/del_1/defer');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ available_at: availableAt, reason: 'busy' });
    });
  });
});
