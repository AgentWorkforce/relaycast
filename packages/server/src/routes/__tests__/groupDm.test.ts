import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/groupDm.js', () => ({
  createGroupDm: vi.fn(),
  postGroupMessage: vi.fn(),
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
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
import { groupDmRoutes } from '../../routes/groupDm.js';
import { getDb } from '../../db/index.js';
import * as groupDmEngine from '../../engine/groupDm.js';
import {
  createMockBindings, mockDbForAgentAuth, agentAuthHeaders, FAKE_WORKSPACE,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', groupDmRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/dm/group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('creates a group DM and returns 201', async () => {
    vi.mocked(groupDmEngine.createGroupDm).mockResolvedValue({
      id: 'conv_group_1',
      channel_id: 'ch_group_1',
      dm_type: 'group',
      name: 'My Group',
      participants: [
        { agent_id: 'agent_456' },
        { agent_id: 'agent_789' },
        { agent_id: 'agent_012' },
      ],
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/dm/group', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ participants: ['Agent2', 'Agent3'], name: 'My Group' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('conv_group_1');
    expect(body.data.dm_type).toBe('group');
  });

  it('returns 400 when participants missing', async () => {
    const res = await app.request('/v1/dm/group', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('POST /v1/dm/:conversation_id/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('posts a message to group DM', async () => {
    vi.mocked(groupDmEngine.postGroupMessage).mockResolvedValue({
      id: 'msg_group_1',
      conversation_id: 'conv_group_1',
      agent_id: 'agent_456',
      text: 'Hello group',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/dm/conv_group_1/messages', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ text: 'Hello group' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.text).toBe('Hello group');
    expect(bindings.WEBHOOK_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'group_dm.received',
      workspaceId: FAKE_WORKSPACE.id,
      data: expect.objectContaining({ conversation_id: 'conv_group_1' }),
    }));
  });

  it('returns 400 when text missing', async () => {
    const res = await app.request('/v1/dm/conv_group_1/messages', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('POST /v1/dm/:conversation_id/participants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('adds a participant', async () => {
    vi.mocked(groupDmEngine.addParticipant).mockResolvedValue({
      conversation_id: 'conv_group_1',
      agent: 'NewBot',
      already_member: false,
    });

    const res = await app.request('/v1/dm/conv_group_1/participants', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ agent_name: 'NewBot' }),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.agent).toBe('NewBot');
  });

  it('returns 400 when agent missing', async () => {
    const res = await app.request('/v1/dm/conv_group_1/participants', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /v1/dm/:conversation_id/participants/:agent_name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('removes participant and returns 204', async () => {
    vi.mocked(groupDmEngine.removeParticipant).mockResolvedValue(undefined);

    const res = await app.request('/v1/dm/conv_group_1/participants/TestBot', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(204);
  });

  it('returns 403 for non-participant', async () => {
    vi.mocked(groupDmEngine.removeParticipant).mockRejectedValue(
      Object.assign(new Error('Not a participant in this conversation'), {
        code: 'forbidden',
        status: 403,
      }),
    );

    const res = await app.request('/v1/dm/conv_group_1/participants/TestBot', {
      method: 'DELETE',
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error.code).toBe('forbidden');
  });
});
