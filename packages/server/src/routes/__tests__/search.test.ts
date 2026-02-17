import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/search.js', () => ({
  searchMessages: vi.fn(),
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
import { searchRoutes } from '../../routes/search.js';
import { getDb } from '../../db/index.js';
import * as searchEngine from '../../engine/search.js';
import {
  createMockBindings, mockDbForAgentAuth, mockDbForWorkspaceAuth,
  agentAuthHeaders, wsAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', searchRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('GET /v1/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('returns search results', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([
      {
        id: 'msg_001',
        channel_name: 'general',
        agent_name: 'Alice',
        text: 'deployment error occurred',
        created_at: '2025-01-01T00:00:00.000Z',
        relevance_score: 0.85,
      },
    ]);

    const res = await app.request('/v1/search?q=deployment+error', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].text).toContain('deployment error');
    expect(body.data[0].relevance_score).toBe(0.85);
  });

  it('returns 400 when q is missing', async () => {
    const res = await app.request('/v1/search', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 400 when q is empty string', async () => {
    const res = await app.request('/v1/search?q=', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
  });

  it('passes filters to engine', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    await app.request('/v1/search?q=test&channel=general&from=Alice&limit=10', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(searchEngine.searchMessages).toHaveBeenCalledWith(expect.anything(), 'ws_123', {
      q: 'test',
      channel: 'general',
      from: 'Alice',
      limit: 10,
      before: undefined,
      after: undefined,
    });
  });

  it('returns empty array for no results', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    const res = await app.request('/v1/search?q=nonexistentterm', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toEqual([]);
  });

  it('works with workspace key (requireAuth)', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    const res = await app.request('/v1/search?q=test', {
      headers: wsAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it('passes cursor pagination params', async () => {
    vi.mocked(searchEngine.searchMessages).mockResolvedValue([]);

    await app.request('/v1/search?q=test&before=msg_100&after=msg_050', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(searchEngine.searchMessages).toHaveBeenCalledWith(expect.anything(), 'ws_123', {
      q: 'test',
      channel: undefined,
      from: undefined,
      limit: undefined,
      before: 'msg_100',
      after: 'msg_050',
    });
  });

  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/search?q=test', {}, bindings);
    expect(res.status).toBe(401);
  });

  it('handles engine errors gracefully', async () => {
    vi.mocked(searchEngine.searchMessages).mockRejectedValue(new Error('Search failed'));

    const res = await app.request('/v1/search?q=test', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal_error');
  });
});
