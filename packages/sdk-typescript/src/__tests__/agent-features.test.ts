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

describe('AgentClient features', () => {
  let me: AgentClient;

  beforeEach(() => {
    mockFetch.mockReset();
    me = new AgentClient(new HttpClient({ apiKey: 'at_live_test123' }));
  });

  describe('channels', () => {
    it('create() posts to /v1/channels', async () => {
      mockFetch.mockImplementation(() => mockResponse({ name: 'dev' }));
      await me.channels.create({ name: 'dev', topic: 'Dev channel' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(
        JSON.stringify({ name: 'dev', topic: 'Dev channel' }),
      );
    });

    it('list() gets /v1/channels', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.channels.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels');
      expect(init.method).toBe('GET');
    });

    it('list() passes includeArchived', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.channels.list({ includeArchived: true });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/channels?include_archived=true',
      );
    });

    it('get() gets /v1/channels/:name', async () => {
      mockFetch.mockImplementation(() =>
        mockResponse({ name: 'dev', members: [] }),
      );
      await me.channels.get('dev');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev');
    });

    it('join() posts to /v1/channels/:name/join', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.join('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/join');
      expect(init.method).toBe('POST');
    });

    it('leave() posts to /v1/channels/:name/leave', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.leave('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/leave');
      expect(init.method).toBe('POST');
    });

    it('setTopic() patches /v1/channels/:name/topic', async () => {
      mockFetch.mockImplementation(() => mockResponse({ topic: 'New' }));
      await me.channels.setTopic('dev', 'New');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/topic');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ topic: 'New' }));
    });

    it('archive() deletes /v1/channels/:name', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.archive('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev');
      expect(init.method).toBe('DELETE');
    });

    it('invite() posts to /v1/channels/:name/invite', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.invite('dev', 'Bot');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/invite');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ agent_name: 'Bot' }));
    });

    it('update() patches /v1/channels/:name', async () => {
      mockFetch.mockImplementation(() =>
        mockResponse({ name: 'dev', topic: 'Updated topic' }),
      );
      await me.channels.update('dev', { topic: 'Updated topic' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ topic: 'Updated topic' }));
    });

    it('members() gets /v1/channels/:name/members', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.channels.members('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/members');
      expect(init.method).toBe('GET');
    });

    it('mute() posts to /v1/channels/:name/mute', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.mute('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/mute');
      expect(init.method).toBe('POST');
    });

    it('unmute() posts to /v1/channels/:name/unmute', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.channels.unmute('dev');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/channels/dev/unmute');
      expect(init.method).toBe('POST');
    });
  });

  describe('reactions', () => {
    it('react() posts to /v1/messages/:id/reactions', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.react('m_1', 'eyes');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/messages/m_1/reactions',
      );
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ emoji: 'eyes' }));
    });

    it('unreact() deletes /v1/messages/:id/reactions/:emoji', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.unreact('m_1', 'eyes');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/messages/m_1/reactions/eyes',
      );
      expect(init.method).toBe('DELETE');
    });

    it('reactions() gets /v1/messages/:id/reactions', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.reactions('m_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/messages/m_1/reactions',
      );
      expect(init.method).toBe('GET');
    });
  });

  describe('search', () => {
    it('search() passes query to /v1/search', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.search('deploy error');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/search?q=deploy+error',
      );
    });

    it('search() passes opts', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.search('err', { channel: 'dev', from: 'Bot', limit: 5 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/search?q=err&channel=dev&from=Bot&limit=5',
      );
    });
  });

  describe('inbox', () => {
    it('inbox() gets /v1/inbox', async () => {
      const rawData = {
        unread_channels: [],
        mentions: [],
        unread_dms: [],
      };
      mockFetch.mockImplementation(() => mockResponse(rawData));
      const res = await me.inbox();

      expect(res).toEqual({
        unreadChannels: [],
        mentions: [],
        unreadDms: [],
      });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/inbox');
      expect(init.method).toBe('GET');
    });
  });

  describe('read receipts', () => {
    it('markRead() posts to /v1/messages/:id/read', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.markRead('m_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/messages/m_1/read');
      expect(init.method).toBe('POST');
    });

    it('readers() gets /v1/messages/:id/readers', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.readers('m_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/messages/m_1/readers');
      expect(init.method).toBe('GET');
    });

    it('readStatus() strips # prefix', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.readStatus('#general');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/channels/general/read-status',
      );
    });

    it('readStatus() works without # prefix', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.readStatus('general');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/channels/general/read-status',
      );
    });
  });

  describe('files', () => {
    it('upload() posts to /v1/files/upload', async () => {
      mockFetch.mockImplementation(() =>
        mockResponse({ file_id: 'f_1', upload_url: 'https://s3/...' }),
      );
      await me.files.upload({
        filename: 'log.txt',
        contentType: 'text/plain',
        sizeBytes: 1024,
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/files/upload');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(
        JSON.stringify({
          filename: 'log.txt',
          content_type: 'text/plain',
          size_bytes: 1024,
        }),
      );
    });

    it('complete() posts to /v1/files/:id/complete', async () => {
      mockFetch.mockImplementation(() => mockResponse({ file_id: 'f_1' }));
      await me.files.complete('f_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/files/f_1/complete');
      expect(init.method).toBe('POST');
    });

    it('get() gets /v1/files/:id', async () => {
      mockFetch.mockImplementation(() => mockResponse({ file_id: 'f_1' }));
      await me.files.get('f_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/files/f_1');
      expect(init.method).toBe('GET');
    });

    it('delete() deletes /v1/files/:id', async () => {
      mockFetch.mockImplementation(() => mockResponse({}));
      await me.files.delete('f_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/files/f_1');
      expect(init.method).toBe('DELETE');
    });

    it('list() gets /v1/files', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.files.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://gateway.relaycast.dev/v1/files');
      expect(init.method).toBe('GET');
    });

    it('list() passes query params', async () => {
      mockFetch.mockImplementation(() => mockResponse([]));
      await me.files.list({ uploadedBy: 'Bot', limit: 10 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe(
        'https://gateway.relaycast.dev/v1/files?uploaded_by=Bot&limit=10',
      );
    });

  });
});
