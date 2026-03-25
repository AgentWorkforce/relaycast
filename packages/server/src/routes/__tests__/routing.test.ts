import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../engine/routing.js', () => ({
  routeBySkill: vi.fn(),
  searchSkills: vi.fn(),
  getRoutingConfig: vi.fn(),
  setRoutingConfig: vi.fn(),
  recordRoutingSuccess: vi.fn(),
  recordRoutingFailure: vi.fn(),
}));

vi.mock('../../engine/directory.js', () => ({
  syncSourceAgentDirectoryEntry: vi.fn(),
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

import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { dbMiddleware } from '../../middleware/db.js';
import { routingRoutes } from '../../routes/routing.js';
import { getDb } from '../../db/index.js';
import * as routingEngine from '../../engine/routing.js';
import {
  agentAuthHeaders,
  createMockBindings,
  mockDbForAgentAuth,
  mockDbForWorkspaceAuth,
  wsAuthHeaders,
} from '../../__tests__/test-helpers.js';

const bindings = createMockBindings();

const app = new Hono<AppEnv>();
app.use('*', dbMiddleware);
const v1 = new Hono<AppEnv>();
v1.route('/', routingRoutes);
app.route('/v1', v1);

app.onError((err, c) => {
  const error = err as Error & { code?: string; status?: number };
  return c.json({ ok: false, error: { code: error.code || 'internal_error', message: error.message } }, (error.status || 500) as any);
});

describe('routing routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDbForAgentAuth());
  });

  it('routes by skill', async () => {
    vi.mocked(routingEngine.routeBySkill).mockResolvedValue({
      agentName: 'BillingBot',
      score: 0.9123,
      fallback: false,
    });

    const res = await app.request('/v1/route', {
      method: 'POST',
      headers: agentAuthHeaders(),
      body: JSON.stringify({ skill: 'refunds', message: 'customer wants a refund' }),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({
      agent_name: 'BillingBot',
      score: 0.9123,
      fallback: false,
    });
    expect(routingEngine.routeBySkill).toHaveBeenCalledWith(
      expect.anything(),
      'ws_123',
      'refunds',
      'customer wants a refund',
    );
  });

  it('searches indexed skills', async () => {
    vi.mocked(routingEngine.searchSkills).mockResolvedValue([
      { agent_name: 'BillingBot', skill_name: 'refunds', description: 'Process refunds', tags: ['billing'], relevance_score: 0.8 },
    ]);

    const res = await app.request('/v1/skills/search?q=refund&limit=5', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(routingEngine.searchSkills).toHaveBeenCalledWith(expect.anything(), 'ws_123', { q: 'refund', limit: 5 });
  });

  it('gets routing config', async () => {
    vi.mocked(routingEngine.getRoutingConfig).mockResolvedValue({
      weights: {
        skill_match: 0.45,
        message_match: 0.2,
        tag_match: 0.15,
        rating: 0.1,
        availability: 0.1,
      },
      circuit_breaker_threshold: 3,
      circuit_breaker_cooldown_seconds: 300,
      updated_at: null,
    });

    const res = await app.request('/v1/routing/config', {
      headers: agentAuthHeaders(),
    }, bindings);

    expect(res.status).toBe(200);
    expect(routingEngine.getRoutingConfig).toHaveBeenCalledWith(expect.anything(), 'ws_123');
  });

  it('updates routing config with workspace auth', async () => {
    vi.mocked(getDb).mockReturnValue(mockDbForWorkspaceAuth());
    vi.mocked(routingEngine.setRoutingConfig).mockResolvedValue({
      weights: {
        skill_match: 0.5,
        message_match: 0.2,
        tag_match: 0.1,
        rating: 0.1,
        availability: 0.1,
      },
      circuit_breaker_threshold: 4,
      circuit_breaker_cooldown_seconds: 600,
      updated_at: '2026-03-24T00:00:00.000Z',
    });

    const res = await app.request('/v1/routing/config', {
      method: 'PUT',
      headers: wsAuthHeaders(),
      body: JSON.stringify({
        weights: { skill_match: 0.5, message_match: 0.2, tag_match: 0.1, rating: 0.1, availability: 0.1 },
        circuit_breaker_threshold: 4,
        circuit_breaker_cooldown_seconds: 600,
      }),
    }, bindings);

    expect(res.status).toBe(200);
    expect(routingEngine.setRoutingConfig).toHaveBeenCalledWith(expect.anything(), 'ws_123', {
      weights: { skill_match: 0.5, message_match: 0.2, tag_match: 0.1, rating: 0.1, availability: 0.1 },
      circuit_breaker_threshold: 4,
      circuit_breaker_cooldown_seconds: 600,
    });
  });
});
