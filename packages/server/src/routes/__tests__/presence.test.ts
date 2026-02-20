import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/presence.js', () => ({
  getPresence: vi.fn(),
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
import { presenceRoutes } from '../../routes/presence.js';
import * as presenceEngine from '../../engine/presence.js';
import { getDb } from '../../db/index.js';
import {
  mockDbForWorkspaceAuth,
  mockDbForAgentAuth,
  wsAuthHeaders,
  agentAuthHeaders,
  createMockBindings,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  (c as any).env = { ...bindings };
  await next();
});
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', presenceRoutes);
app.route('/v1', v1);

describe('GET /v1/agents/presence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns presence (2 online, 1 offline)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(presenceEngine.getPresence).mockResolvedValue([
      { agent_id: 'agent_1', agent_name: 'Alice', status: 'online' },
      { agent_id: 'agent_2', agent_name: 'Bob', status: 'online' },
      { agent_id: 'agent_3', agent_name: 'Charlie', status: 'offline' },
    ]);

    const res = await app.request('/v1/agents/presence', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({
      agent_id: 'agent_1',
      agent_name: 'Alice',
      status: 'online',
    });
    expect(body.data[1].status).toBe('online');
    expect(body.data[2].status).toBe('offline');
  });

  it('returns empty array when no agents', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(presenceEngine.getPresence).mockResolvedValue([]);

    const res = await app.request('/v1/agents/presence', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('works with agent token', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
    vi.mocked(presenceEngine.getPresence).mockResolvedValue([
      { agent_id: 'agent_123', agent_name: 'TestBot', status: 'online' },
    ]);

    const res = await app.request('/v1/agents/presence', {
      method: 'GET',
      headers: agentAuthHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].agent_name).toBe('TestBot');
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/agents/presence', { method: 'GET' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it('handles engine errors gracefully', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(presenceEngine.getPresence).mockRejectedValue(
      new Error('Redis connection failed'),
    );

    const res = await app.request('/v1/agents/presence', {
      method: 'GET',
      headers: wsAuthHeaders(),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal_error');
  });
});

describe('POST /v1/agents/disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards disconnect to PresenceDO with agent name', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());

    const res = await app.request('/v1/agents/disconnect', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const presenceGet = (bindings.PRESENCE_DO as any).get as any;
    expect(presenceGet).toHaveBeenCalledWith('presence-do');

    const presenceStub = presenceGet.mock.results[0].value as { fetch: any };
    const req = presenceStub.fetch.mock.calls[0][0] as Request;
    await expect(req.clone().json()).resolves.toEqual({
      agentId: 'agent_123',
      workspaceId: 'ws_123',
      agentName: 'TestBot',
    });
  });
});
