import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent.js';
import { HttpClient, RelayError } from '../client.js';

describe('AgentClient.channels.ensureJoined', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates and joins when missing', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { id: 'ch_1', workspace_id: 'w_1', name: 'general', channel_type: 0, topic: 'General discussion', metadata: {}, created_by: 'agent_1', created_at: '2026-03-26T00:00:00Z', is_archived: false } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { channel: 'general', agent_id: 'agent_1', already_member: false } }), { status: 200 }));

    const client = new AgentClient(new HttpClient({ apiKey: 'at_live_test', baseUrl: 'https://api.relaycast.dev' }));
    await expect(client.channels.ensureJoined('general', { topic: 'General discussion' })).resolves.toEqual({ created: true, joined: true });
  });

  it('treats duplicate create plus already-member join as success', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'channel_already_exists', message: 'exists' } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { channel: 'general', agent_id: 'agent_1', already_member: true } }), { status: 200 }));

    const client = new AgentClient(new HttpClient({ apiKey: 'at_live_test', baseUrl: 'https://api.relaycast.dev' }));
    await expect(client.channels.ensureJoined('general')).resolves.toEqual({ created: false, joined: false });
  });

  it('does not swallow join conflicts', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'channel_already_exists', message: 'exists' } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { code: 'already_joined', message: 'joined' } }), { status: 409 }));

    const client = new AgentClient(new HttpClient({ apiKey: 'at_live_test', baseUrl: 'https://api.relaycast.dev' }));

    await expect(client.channels.ensureJoined('general')).rejects.toMatchObject({
      statusCode: 409,
      rawCode: 'already_joined',
    } satisfies Partial<RelayError>);
  });
});
