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

describe('AgentClient', () => {
  let me: AgentClient;

  beforeEach(() => {
    mockFetch.mockReset();
    me = new AgentClient(new HttpClient({ apiKey: 'at_live_test123' }));
  });

  describe('send()', () => {
    it('posts to /v1/channels/:name/messages', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('general', 'hello');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ text: 'hello', mode: 'wait' }));
    });

    it('strips # prefix from channel name', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
    });

    it('URL-encodes channel name', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#a/b', 'hello');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/a%2Fb/messages');
    });

    it('includes attachments when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello', { attachments: ['att_1', 'att_2'] });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ text: 'hello', attachments: ['att_1', 'att_2'], mode: 'wait' }));
    });

    it('defaults mode to wait when omitted', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello');

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ text: 'hello', mode: 'wait' }));
    });

    it('forwards steer mode when requested', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello', { mode: 'steer' });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ text: 'hello', mode: 'steer' }));
    });

    it('forwards Idempotency-Key when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello', { idempotencyKey: 'msg-key-1' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('msg-key-1');
      expect(headers['X-Idempotency-Key']).toBe('msg-key-1');
    });

    it('auto-generates idempotency headers when key is not provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.send('#general', 'hello');

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      const generated = headers['Idempotency-Key'];
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(0);
      expect(headers['X-Idempotency-Key']).toBe(generated);
    });
  });

  describe('post()', () => {
    it('aliases send() for channel messages', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.post('#general', 'hello');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ text: 'hello', mode: 'wait' }));
    });
  });

  describe('messages()', () => {
    it('gets from /v1/channels/:name/messages', async () => {
      mockFetch.mockImplementation(() => mockResponse([{ id: 'm_1' }]));

      const res = await me.messages('#general');

      expect(res).toEqual([{ id: 'm_1' }]);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
      expect(init.method).toBe('GET');
    });

    it('passes query params', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));

      await me.messages('#general', { limit: 10, before: 'm_2', after: 'm_0' } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://api.relaycast.dev/v1/channels/general/messages?limit=10&before=m_2&after=m_0',
      );
    });
  });

  describe('message()', () => {
    it('gets a single message by ID', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_1' }));

      await me.message('m_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m_1');
      expect(init.method).toBe('GET');
    });

    it('URL-encodes message ID', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm/1' }));

      await me.message('m/1');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m%2F1');
    });
  });

  describe('reply()', () => {
    it('posts to /v1/messages/:id/replies', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.reply('m_1', 'reply');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m_1/replies');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ text: 'reply' }));
    });

    it('forwards Idempotency-Key when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.reply('m_1', 'reply', { idempotencyKey: 'reply-key-1' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('reply-key-1');
      expect(headers['X-Idempotency-Key']).toBe('reply-key-1');
    });

    it('auto-generates idempotency headers when key is not provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.reply('m_1', 'reply');

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      const generated = headers['Idempotency-Key'];
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(0);
      expect(headers['X-Idempotency-Key']).toBe(generated);
    });
  });

  describe('thread()', () => {
    it('gets thread from /v1/messages/:id/replies', async () => {
      const payload = { parent: { id: 'm_1' }, replies: [{ id: 'm_2' }] };
      mockFetch.mockImplementation(() => mockResponse(payload));

      const res = await me.thread('m_1');

      expect(res).toEqual(payload);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m_1/replies');
      expect(init.method).toBe('GET');
    });

    it('passes query params', async () => {
      mockFetch.mockImplementation(() => mockResponse({ parent: { id: 'm_1' }, replies: [] }));

      await me.thread('m_1', { limit: 25 } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/m_1/replies?limit=25');
    });
  });

  describe('dm()', () => {
    it('sends DM via POST /v1/dm', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'dm_1' }));

      await me.dm('Worker-1', 'hi');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ to: 'Worker-1', text: 'hi', mode: 'wait' }));
    });

    it('forwards steer mode when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'dm_1' }));

      await me.dm('Worker-1', 'hi', { mode: 'steer' });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ to: 'Worker-1', text: 'hi', mode: 'steer' }));
    });

    it('forwards attachments when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'dm_1' }));

      await me.dm('Worker-1', 'hi', { attachments: ['file_1', 'file_2'] });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ to: 'Worker-1', text: 'hi', attachments: ['file_1', 'file_2'], mode: 'wait' }));
    });

    it('forwards Idempotency-Key when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'dm_1' }));

      await me.dm('Worker-1', 'hi', { idempotencyKey: 'dm-key-1' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('dm-key-1');
      expect(headers['X-Idempotency-Key']).toBe('dm-key-1');
    });

    it('auto-generates idempotency headers when key is not provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'dm_1' }));

      await me.dm('Worker-1', 'hi');

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      const generated = headers['Idempotency-Key'];
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(0);
      expect(headers['X-Idempotency-Key']).toBe(generated);
    });
  });

  describe('dms', () => {
    it('conversations() lists DM conversations (and is safe to destructure)', async () => {
      mockFetch.mockImplementation(() => mockResponse([{ id: 'c_1' }]));

      const { conversations } = me.dms;
      const res = await conversations();

      expect(res).toEqual([{ id: 'c_1' }]);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/conversations');
      expect(init.method).toBe('GET');
    });

    it('messages() gets conversation messages', async () => {
      mockFetch.mockImplementation(() => mockResponse([{
        id: 'm_1',
        agent_id: 'a_1',
        agent_name: 'Alice',
        text: 'hello',
        created_at: '2025-01-01T00:00:00.000Z',
      }]));

      const res = await me.dms.messages('c_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/c_1/messages');
      expect(init.method).toBe('GET');
      expect(res[0]).toEqual({
        id: 'm_1',
        agentId: 'a_1',
        agentName: 'Alice',
        text: 'hello',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
    });

    it('messages() passes query params', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));

      await me.dms.messages('c_1', { limit: 2, before: 'm_9' } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/c_1/messages?limit=2&before=m_9');
    });

    it('createGroup() creates group DM', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'c_2' }));

      await me.dms.createGroup({ participants: ['a', 'b'] } as any);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/group');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ participants: ['a', 'b'] }));
      const headers = init.headers as Record<string, string>;
      const generated = headers['Idempotency-Key'];
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(0);
      expect(headers['X-Idempotency-Key']).toBe(generated);
    });

    it('createGroup() forwards Idempotency-Key when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'c_2' }));

      await me.dms.createGroup({ participants: ['a', 'b'] } as any, { idempotencyKey: 'group-key-1' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('group-key-1');
      expect(headers['X-Idempotency-Key']).toBe('group-key-1');
    });

    it('sendMessage() sends to conversation', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.dms.sendMessage('c_1', 'hello');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/c_1/messages');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ text: 'hello', mode: 'wait' }));
      const headers = init.headers as Record<string, string>;
      const generated = headers['Idempotency-Key'];
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(0);
      expect(headers['X-Idempotency-Key']).toBe(generated);
    });

    it('sendMessage() forwards mode + attachments', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.dms.sendMessage('c_1', 'hello', {
        mode: 'steer',
        attachments: ['file_1'],
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({ text: 'hello', attachments: ['file_1'], mode: 'steer' }));
    });

    it('sendMessage() forwards Idempotency-Key when provided', async () => {
      mockFetch.mockImplementation(() => mockResponse({ id: 'm_2' }));

      await me.dms.sendMessage('c_1', 'hello', { idempotencyKey: 'gdm-key-1' });

      const [, init] = mockFetch.mock.calls[0]!;
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('gdm-key-1');
      expect(headers['X-Idempotency-Key']).toBe('gdm-key-1');
    });

    it('addParticipant() adds agent', async () => {
      mockFetch.mockImplementation(() => mockResponse({ ok: true }));

      await me.dms.addParticipant('c_1', 'Worker-2');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/c_1/participants');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ agent_name: 'Worker-2' }));
    });

    it('removeParticipant() removes agent', async () => {
      mockFetch.mockImplementation(() => mockResponse({ ok: true }));

      await me.dms.removeParticipant('c_1', 'a/b');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/c_1/participants/a%2Fb');
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();
    });
  });
});
