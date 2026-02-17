import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/agent.js', () => ({
  registerAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentByName: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { agentRoutes } from '../../routes/agent.js';
import { getDb } from '../../db/index.js';
import * as agentEngine from '../../engine/agent.js';
import {
  createMockBindings, mockDbForWorkspaceAuth, wsAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', agentRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('POST /v1/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('registers an agent and returns 201 with token', async () => {
    vi.mocked(agentEngine.registerAgent).mockResolvedValue({
      id: 'agent_456',
      name: 'CodeReviewer',
      token: 'at_live_tokenvalue123',
      status: 'online',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CodeReviewer', persona: 'Senior code reviewer' }),
    }, bindings);

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('CodeReviewer');
    expect(body.data.token).toContain('at_live_');
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({}),
    }, bindings);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 409 for duplicate agent name', async () => {
    vi.mocked(agentEngine.registerAgent).mockRejectedValue(
      Object.assign(new Error('Agent "CodeReviewer" already exists'), {
        code: 'agent_already_exists',
        status: 409,
      }),
    );

    const res = await app.request('/v1/agents', {
      method: 'POST',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ name: 'CodeReviewer' }),
    }, bindings);
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('agent_already_exists');
  });
});

describe('GET /v1/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('lists agents', async () => {
    vi.mocked(agentEngine.listAgents).mockResolvedValue([
      {
        id: 'agent_1',
        name: 'Bot1',
        type: 'agent',
        status: 'online',
        persona: null,
        last_seen: '2025-01-01T00:00:00.000Z',
        metadata: {},
      },
    ]);

    const res = await app.request('/v1/agents', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Bot1');
  });

  it('filters agents by status', async () => {
    vi.mocked(agentEngine.listAgents).mockResolvedValue([]);

    await app.request('/v1/agents?status=online', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(agentEngine.listAgents).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'online');
  });
});

describe('GET /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('returns agent by name', async () => {
    vi.mocked(agentEngine.getAgentByName).mockResolvedValue({
      id: 'agent_1',
      name: 'Bot1',
      type: 'agent',
      status: 'online',
      persona: 'Helper bot',
      last_seen: '2025-01-01T00:00:00.000Z',
      metadata: {},
      channels: [{ id: 'ch_1', name: 'general', role: 'member', joined_at: '2025-01-01T00:00:00.000Z' }],
    });

    const res = await app.request('/v1/agents/Bot1', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.name).toBe('Bot1');
    expect(body.data.channels).toHaveLength(1);
  });

  it('returns 404 for unknown agent', async () => {
    vi.mocked(agentEngine.getAgentByName).mockResolvedValue(null);

    const res = await app.request('/v1/agents/Unknown', {
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('agent_not_found');
  });
});

describe('PATCH /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('updates agent', async () => {
    vi.mocked(agentEngine.updateAgent).mockResolvedValue({
      id: 'agent_1',
      name: 'Bot1',
      type: 'agent',
      status: 'offline',
      persona: null,
      last_seen: '2025-01-01T00:00:00.000Z',
      metadata: {},
    });

    const res = await app.request('/v1/agents/Bot1', {
      method: 'PATCH',
      headers: wsAuthHeaders(),
      body: JSON.stringify({ status: 'offline' }),
    }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('offline');
  });
});

describe('DELETE /v1/agents/:name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
  });

  it('deletes agent and returns 204', async () => {
    vi.mocked(agentEngine.deleteAgent).mockResolvedValue(true);

    const res = await app.request('/v1/agents/Bot1', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown agent', async () => {
    vi.mocked(agentEngine.deleteAgent).mockResolvedValue(false);

    const res = await app.request('/v1/agents/Unknown', {
      method: 'DELETE',
      headers: wsAuthHeaders(),
    }, bindings);
    expect(res.status).toBe(404);
  });
});
