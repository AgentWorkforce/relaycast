import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/reaction.js', () => ({
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getReactions: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../lib/serverTelemetry.js', () => ({
  emitServerEvent: vi.fn(),
}));

vi.mock('../fanout.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../fanout.js')>();
  return {
    ...original,
    fanoutToChannel: vi.fn().mockResolvedValue(undefined),
    fanoutToAgents: vi.fn().mockResolvedValue(undefined),
    getDmParticipantAgentIds: vi.fn().mockResolvedValue(null),
  };
});

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { reactionRoutes } from '../../routes/reaction.js';
import { getDb } from '../../db/index.js';
import * as reactionEngine from '../../engine/reaction.js';
import { emitServerEvent } from '../../lib/serverTelemetry.js';
import { fanoutToChannel, fanoutToAgents, getDmParticipantAgentIds } from '../fanout.js';
import {
  createMockBindings, mockDbForAgentAuth, mockDbForWorkspaceAuth,
  agentAuthHeaders, wsAuthHeaders,
  TEST_AGENT_TOKEN, TEST_API_KEY, FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', reactionRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/messages/:id/reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('adds a reaction and returns 201', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_001',
      message_id: 'msg_001',
      agent_name: 'TestBot',
      emoji: 'eyes',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/messages/msg_001/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'eyes' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.emoji).toBe('eyes');
    expect(body.data.agent_name).toBe('TestBot');
    expect(reactionEngine.addReaction).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'msg_001', 'agent_123', 'eyes');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'reaction.added',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ message_id: 'msg_001', emoji: 'eyes' }),
    }));
    expect(emitServerEvent).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'relaycast_server_reaction_added',
      expect.objectContaining({
        message_id: 'msg_001',
      }),
    );
  });

  it('is idempotent (same emoji twice returns 201)', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_001',
      message_id: 'msg_001',
      agent_name: 'TestBot',
      emoji: 'eyes',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res1 = await app.request('/v1/messages/msg_001/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'eyes' }),
    }, bindings);
    const res2 = await app.request('/v1/messages/msg_001/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'eyes' }),
    }, bindings);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });

  it('returns 400 when emoji is missing', async () => {
    const res = await app.request('/v1/messages/msg_001/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(reactionEngine.addReaction).mockResolvedValue(null);

    const res = await app.request('/v1/messages/msg_999/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'eyes' }),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });

  it('uses fanoutToAgents when reaction is on a DM message', async () => {
    vi.mocked(getDmParticipantAgentIds).mockResolvedValue(['agent_a', 'agent_b']);
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_dm',
      message_id: 'msg_dm',
      agent_name: 'TestBot',
      emoji: 'heart',
      created_at: '2025-01-01T00:00:00.000Z',
      channel_id: 'dmch_100',
      channel_name: 'dm',
    });

    const res = await app.request('/v1/messages/msg_dm/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'heart' }),
    }, bindings);

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(fanoutToAgents).toHaveBeenCalledWith(
        expect.anything(),
        ['agent_a', 'agent_b'],
        'reaction.added',
        expect.objectContaining({ emoji: 'heart' }),
      );
    });
    expect(fanoutToChannel).not.toHaveBeenCalled();
  });

  it('uses fanoutToChannel when reaction is on a regular channel message', async () => {
    vi.mocked(getDmParticipantAgentIds).mockResolvedValue(null);
    vi.mocked(reactionEngine.addReaction).mockResolvedValue({
      id: 'rxn_ch',
      message_id: 'msg_ch',
      agent_name: 'TestBot',
      emoji: 'fire',
      created_at: '2025-01-01T00:00:00.000Z',
      channel_id: 'ch_456',
      channel_name: 'general',
    });

    const res = await app.request('/v1/messages/msg_ch/reactions', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ emoji: 'fire' }),
    }, bindings);

    expect(res.status).toBe(201);
    await vi.waitFor(() => {
      expect(fanoutToChannel).toHaveBeenCalledWith(
        expect.anything(),
        'ch_456',
        'reaction.added',
        expect.objectContaining({ emoji: 'fire' }),
      );
    });
    expect(fanoutToAgents).not.toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/messages/msg_001/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: 'eyes' }),
    }, bindings);

    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/messages/:id/reactions/:emoji', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('removes a reaction and returns 204', async () => {
    vi.mocked(reactionEngine.removeReaction).mockResolvedValue(true);

    const res = await app.request('/v1/messages/msg_001/reactions/eyes', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(204);
    expect(reactionEngine.removeReaction).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'msg_001', 'agent_123', 'eyes');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'reaction.removed',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ message_id: 'msg_001', emoji: 'eyes' }),
    }));
    expect(emitServerEvent).toHaveBeenCalledWith(
      expect.anything(),
      FAKE_WORKSPACE.id,
      'relaycast_server_reaction_removed',
      expect.objectContaining({
        message_id: 'msg_001',
      }),
    );
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(reactionEngine.removeReaction).mockResolvedValue(null);

    const res = await app.request('/v1/messages/msg_999/reactions/eyes', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });
});

describe('GET /v1/messages/:id/reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns aggregated reactions with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'eyes', count: 2, agents: ['Alice', 'Bob'] },
      { emoji: 'fire', count: 1, agents: ['Carol'] },
    ]);

    const res = await app.request('/v1/messages/msg_001/reactions', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].emoji).toBe('eyes');
    expect(body.data[0].count).toBe(2);
    expect(body.data[0].agents).toEqual(['Alice', 'Bob']);
  });

  it('works with workspace key (requireAuth)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'thumbsup', count: 3, agents: ['Alice', 'Bob', 'Carol'] },
    ]);

    const res = await app.request('/v1/messages/msg_001/reactions', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data[0].count).toBe(3);
  });

  it('returns 404 when message not found', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(reactionEngine.getReactions).mockResolvedValue(null);

    const res = await app.request('/v1/messages/msg_999/reactions', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('message_not_found');
  });

  it('returns empty array when no reactions', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([]);

    const res = await app.request('/v1/messages/msg_001/reactions', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });

  it('returns correct counts for multiple agents on same emoji', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(reactionEngine.getReactions).mockResolvedValue([
      { emoji: 'eyes', count: 3, agents: ['Alice', 'Bob', 'Carol'] },
    ]);

    const res = await app.request('/v1/messages/msg_001/reactions', {
      headers: agentAuthHeaders(),
    }, bindings);

    const body = await res.json() as any;
    expect(body.data[0].count).toBe(3);
    expect(body.data[0].agents).toHaveLength(3);
  });
});
