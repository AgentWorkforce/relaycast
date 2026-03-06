import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/dm.js', () => ({
  sendDm: vi.fn(),
  listConversations: vi.fn(),
  getDmMessages: vi.fn(),
}));

vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { dmRoutes } from '../../routes/dm.js';
import { getDb } from '../../db/index.js';
import * as dmEngine from '../../engine/dm.js';
import {
  createMockBindings, mockDbForAgentAuth, agentAuthHeaders, FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', dmRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/dm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('sends a DM and returns 201', async () => {
    vi.mocked(dmEngine.sendDm).mockResolvedValue({
      id: 'msg_001',
      conversation_id: 'conv_123',
      from_agent_id: 'agent_456',
      to: 'OtherBot',
      text: 'Hello DM',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/dm', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ to: 'OtherBot', text: 'Hello DM' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.conversation_id).toBe('conv_123');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dm.received',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ conversation_id: 'conv_123' }),
    }));
  });

  it('returns 400 when to is missing', async () => {
    const res = await app.request('/v1/dm', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'Hello' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when text is missing', async () => {
    const res = await app.request('/v1/dm', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ to: 'OtherBot' }),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('GET /v1/dm/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('lists conversations', async () => {
    vi.mocked(dmEngine.listConversations).mockResolvedValue([
      {
        id: 'conv_123',
        type: '1:1',
        name: null,
        participants: [
          { agent_id: 'agent_456', agent_name: 'TestBot' },
          { agent_id: 'agent_789', agent_name: 'OtherBot' },
        ],
        last_message: {
          id: 'msg_001',
          text: 'Hello',
          agent_id: 'agent_456',
          created_at: '2025-01-01T00:00:00.000Z',
        },
        unread_count: 3,
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/v1/dm/conversations', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].participants).toHaveLength(2);
  });
});

describe('GET /v1/dm/:conversation_id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns paginated messages', async () => {
    vi.mocked(dmEngine.getDmMessages).mockResolvedValue([
      {
        id: 'msg_001',
        agent_id: 'agent_456',
        agent_name: 'TestBot',
        text: 'Hello',
        created_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.request('/v1/dm/conv_123/messages', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agent_name).toBe('TestBot');
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(dmEngine.getDmMessages).mockRejectedValue(
      Object.assign(new Error('Not a participant in this conversation'), {
        code: 'forbidden',
        status: 403,
      }),
    );

    const res = await app.request('/v1/dm/conv_123/messages', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('forbidden');
  });
});
